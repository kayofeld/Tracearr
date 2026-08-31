/**
 * Seerr API client
 *
 * Outbound HTTP client for the Seerr connector (seerr-team/seerr, the
 * Overseerr/Jellyseerr continuation - called "seerr" everywhere, never
 * "jellyseerr"). Owns request/response validation (Zod) and mapping Seerr's
 * paginated request payload into the internal sync record shape consumed by
 * jobs/seerrSyncQueue.ts. Resolution (Seerr requester -> Tracearr user),
 * persistence, and orchestration live in the sync job - this module only
 * talks to Seerr.
 *
 * Contract: docs/architecture/seerr-api-contract.md §2-3.
 * Design: docs/architecture/seerr-connector.md §1 (verified ground truth), §6.
 * Model/precedent: services/ombi.ts (retry/timeout/Zod-validation shape,
 * SSRF/redirect/body-size hardening) - cloned closely, diverging only where
 * Seerr's API shape forces it (pagination, single endpoint for movie+tv,
 * X-Api-Key header, no title field - ADR 0007).
 */

import { z } from 'zod';
import { assertSafeProbeUrl, SsrfBlockedError } from '../utils/ssrf.js';

// ============================================================================
// Timing / retry configuration
// ============================================================================

/** 30s timeout for sync fetches (paginated request/count payloads). */
export const SEERR_SYNC_TIMEOUT_MS = 30_000;
/** 10s timeout for each of the two interactive test-connection calls (contract §2). */
export const SEERR_TEST_CONNECTION_TIMEOUT_MS = 10_000;
/** 3 attempts, linear backoff (1s, 2s) - matches services/ombi.ts. */
export const SEERR_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
/** Response body cap (SEC-03 precedent) - bounds unbounded memory growth from
 * a hostile or misbehaving server. Best-effort: only enforced when
 * Content-Length is sent. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Page size for GET /api/v1/request pagination (design §6). */
export const SEERR_PAGE_SIZE = 100;
/**
 * Absolute pagination ceiling (SEERR-01), independent of anything Seerr
 * reports. `pageInfo.results` is attacker-controlled (only `z.number()`
 * before this fix): a compromised/hostile instance can report an arbitrarily
 * large total while serving a fresh page of distinct ids on every request
 * (defeating the in-memory dedupe), and a cap computed FROM that value -
 * `ceil(pageInfo.results / SEERR_PAGE_SIZE) + 1` - scales right along with
 * it, so it never actually bounds the loop. This ceiling does not scale with
 * any reported number - at SEERR_PAGE_SIZE=100 it bounds the run to 100k
 * fetched records, well above any real instance (108 requests measured) but
 * far short of Node OOM territory.
 */
const MAX_PAGES = 1000;

// ============================================================================
// Column-width caps (SEC-05 precedent) - mirrors db/schema.ts `media_requests`
// varchar widths for seerr rows. Zod strings are otherwise uncapped while the
// Postgres columns are fixed-width, and a single over-long value in a
// multi-row INSERT throws for the WHOLE statement, not just that row - so an
// oversized value must fail validation and be SKIPPED before it ever reaches
// the insert. Identifiers used for joins/matching are SKIPPED when oversized
// (never truncated - a truncated join key corrupts matching); free-text
// display fields are TRUNCATED so the record still syncs.
// ============================================================================
const SEERR_USER_ID_MAX = 64; // media_requests.source_user_id / .source_external_user_id
const DISPLAY_NAME_MAX = 255; // media_requests.source_username / .source_alias
const IMDB_ID_MAX = 20; // media_requests.imdb_id

// SEERR-02: the SEC-05 lesson applied to strings (above) but not numbers -
// tmdbId/tvdbId/id land in Postgres `integer` columns (media_requests.tmdb_id
// / .tvdb_id / the composite upsert key derived from request `id`), and a
// hostile out-of-range value (e.g. 2**40) throws `integer out of range` for
// the WHOLE multi-row upsert statement, not just that row - failing every
// later run identically until the offending record disappears upstream.
// Bound every int-column-bound field so it fails Zod validation and is
// SKIPPED instead (never truncated - these are join/identity keys).
const PG_INTEGER_MIN = -2147483648;
const PG_INTEGER_MAX = 2147483647;
const pgInteger = () => z.number().int().min(PG_INTEGER_MIN).max(PG_INTEGER_MAX);

/**
 * Seerr sends explicit `null` for several optional fields (media.imdbId on
 * movies without an IMDb match, requestedBy.jellyfinUserId on Plex-backed
 * instances, etc.) - a Zod `.default()` only covers `undefined`, not an
 * explicit `null` (the exact bug that dropped 100% of Ombi TV requests on
 * first live sync - services/ombi.ts). Every optional field below is
 * `.nullable().optional()`, never relying on `.default()` alone.
 */

// ============================================================================
// Errors
// ============================================================================

/** Seerr rejected the API key (401/403) - never retried, retrying won't fix bad credentials. */
export class SeerrAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeerrAuthError';
  }
}

/**
 * Seerr returned something that isn't the expected JSON shape (e.g. its SPA
 * index.html served as a fallback for an unknown route, or a payload that
 * doesn't match the paginated {pageInfo, results} shape). Never retried -
 * retrying gets the same body again.
 */
export class SeerrInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeerrInvalidResponseError';
  }
}

// ============================================================================
// Zod schemas - Seerr 3.4.0 payload shapes (verified ground truth, see design §1)
// ============================================================================

// SEERR-01: pageInfo is attacker-controlled (it drives the pagination hard
// cap below) - bound every field to a sane non-negative integer range so a
// hostile/pathological total (e.g. 1e15) is rejected outright rather than
// flowing into the cap computation.
const MAX_SANE_COUNT = 1_000_000;
const seerrPageInfoSchema = z.object({
  pages: z.number().int().nonnegative().max(MAX_SANE_COUNT),
  pageSize: z.number().int().nonnegative().max(MAX_SANE_COUNT),
  results: z.number().int().nonnegative().max(MAX_SANE_COUNT),
  page: z.number().int().nonnegative().max(MAX_SANE_COUNT),
});

const seerrCountSchema = z.object({
  total: z.number(),
  movie: z.number(),
  tv: z.number(),
  pending: z.number(),
  approved: z.number(),
  declined: z.number(),
  processing: z.number(),
  available: z.number(),
  completed: z.number(),
});
export type SeerrRequestCount = z.infer<typeof seerrCountSchema>;

/** Loose - only the fields test-connection cares about; the /status endpoint
 * carries other fields (commitTag, updateAvailable, ...) we don't need. */
const seerrStatusEndpointSchema = z.object({ version: z.string().optional() });

// Per-page array length cap (SEERR-01c) - a hostile server could otherwise
// return an oversized `results` array (within the MAX_RESPONSE_BYTES body
// cap) regardless of what `take=N` asked for; bounded well above any real
// page (we request SEERR_PAGE_SIZE=100) but far short of unbounded growth.
const MAX_RESULTS_PER_PAGE = 1000;

const seerrUserListSchema = z.object({
  pageInfo: seerrPageInfoSchema,
  results: z.array(z.unknown()).max(MAX_RESULTS_PER_PAGE),
});

const seerrMediaSchema = z.object({
  // tmdbId is 100/108-measured but not guaranteed by the API shape - treat as
  // possibly absent rather than assume presence (defensive, no observed
  // counterexample).
  tmdbId: pgInteger().nullable().optional(),
  tvdbId: pgInteger().nullable().optional(),
  // Identifier - oversized value fails validation, record is skipped (SEC-05).
  imdbId: z.string().max(IMDB_ID_MAX).nullable().optional(),
  mediaAddedAt: z.coerce.date().nullable().optional(),
});

const seerrRequestedBySchema = z.object({
  // Numeric Seerr user id - required on every request (ground truth).
  id: z.union([z.number(), z.string().max(SEERR_USER_ID_MAX)]),
  // Strong external id (ADR 0008 primary tier) - identifier, oversized value
  // fails validation rather than being truncated into a corrupted join key.
  jellyfinUserId: z.string().max(SEERR_USER_ID_MAX).nullable().optional(),
  plexId: z
    .union([z.number(), z.string().max(SEERR_USER_ID_MAX)])
    .nullable()
    .optional(),
  jellyfinUsername: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
  plexUsername: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
  username: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
  displayName: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
});

const seerrSeasonSchema = z.object({
  seasonNumber: pgInteger(),
});

const seerrRequestSchema = z.object({
  id: pgInteger(),
  status: z.number(),
  type: z.enum(['movie', 'tv']),
  // Explicit null observed nowhere in the probe, but permissive per the Ombi
  // lesson - a Zod default alone would not cover a future explicit null.
  is4k: z
    .boolean()
    .nullable()
    .optional()
    .transform((v) => v ?? false),
  createdAt: z.coerce.date(),
  media: seerrMediaSchema,
  requestedBy: seerrRequestedBySchema,
  // Array length capped (SEERR-02) - display-only list, no legitimate
  // request needs anywhere near this many seasons.
  seasons: z.array(seerrSeasonSchema).max(1000).nullable().optional(),
});

const seerrRequestListSchema = z.object({
  pageInfo: seerrPageInfoSchema,
  results: z.array(z.unknown()).max(MAX_RESULTS_PER_PAGE),
});

export type SeerrRequest = z.infer<typeof seerrRequestSchema>;

// ============================================================================
// Internal sync record - the shape jobs/seerrSyncQueue.ts consumes
// ============================================================================

export interface SeerrRawRequesterInfo {
  seerrUserId: string;
  seerrUsername: string;
  seerrAlias: string | null;
  /** jellyfinUserId, or plexId when jellyfinUserId is absent (ADR 0008
   * primary match tier) - persisted (unlike Ombi's transient providerUserId)
   * because it is the PRIMARY tier here, not a zero-match future-proof. */
  externalUserId: string | null;
}

export interface SeerrSyncRecord {
  seerrRequestId: number;
  mediaType: 'movie' | 'tv';
  /** Always null in v1 - Seerr's request payload carries no title (ADR 0007). */
  title: null;
  releaseYear: null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  seasons: number[] | null;
  is4k: boolean;
  status: 'pending' | 'approved' | 'denied' | 'available';
  requestedAt: Date;
  availableAt: Date | null;
  requester: SeerrRawRequesterInfo;
}

/** Derives the single status enum from Seerr's status integer (design §4.1).
 * Unknown values default to 'pending' + a warning - never skip the row over
 * status fidelity (attribution outranks status accuracy).
 *
 * Vocabulary verified against seerr-team/seerr's own source
 * (`server/constants/media.ts`, `MediaRequestStatus`): PENDING=1, APPROVED=2,
 * DECLINED=3, FAILED=4, COMPLETED=5. The design doc's original 4=processing
 * guess (inferred from GET /api/v1/request/count's field order, not the
 * enum) was wrong - the count endpoint's `processing`/`available` fields are
 * derived display aggregates, not raw status values. FAILED has no dedicated
 * bucket in the shipped 4-value vocabulary; 'denied' is the closest one (a
 * failed Radarr/Sonarr grab did not proceed, same as a decline), and is far
 * less wrong than 'approved' (which would show a permanently-failed request
 * as still in flight). */
function deriveStatus(status: number, requestId: number): SeerrSyncRecord['status'] {
  switch (status) {
    case 1:
      return 'pending';
    case 2:
      return 'approved';
    case 3:
      return 'denied';
    case 4: // FAILED - mapped onto 'denied', the closest bucket the shipped vocabulary offers
      return 'denied';
    case 5:
      return 'available';
    default:
      console.warn(
        `[Seerr] Unknown status ${status} on request ${requestId}, defaulting to 'pending'`
      );
      return 'pending';
  }
}

function toRequesterInfo(rb: z.infer<typeof seerrRequestedBySchema>): SeerrRawRequesterInfo {
  const externalUserId = rb.jellyfinUserId?.trim()
    ? rb.jellyfinUserId
    : rb.plexId !== null && rb.plexId !== undefined
      ? String(rb.plexId)
      : null;

  // Preference chain (design §4.1): jellyfinUsername ?? plexUsername ??
  // username ?? the id itself (media_requests.source_username is NOT NULL -
  // this instance always has jellyfinUsername populated, but the fallback
  // chain must never leave the column empty on a hypothetical instance that
  // doesn't).
  const username =
    (rb.jellyfinUsername?.trim() ? rb.jellyfinUsername : null) ??
    (rb.plexUsername?.trim() ? rb.plexUsername : null) ??
    (rb.username?.trim() ? rb.username : null) ??
    String(rb.id);

  return {
    seerrUserId: String(rb.id),
    seerrUsername: username,
    seerrAlias: rb.displayName?.trim() ? rb.displayName : null,
    externalUserId,
  };
}

function mapRequestRecord(record: SeerrRequest): SeerrSyncRecord {
  return {
    seerrRequestId: record.id,
    mediaType: record.type,
    title: null, // ADR 0007 - no title on Seerr's request payload
    releaseYear: null,
    imdbId: record.media.imdbId ?? null,
    tmdbId: record.media.tmdbId ?? null,
    tvdbId: record.media.tvdbId ?? null,
    seasons: record.type === 'tv' ? (record.seasons?.map((s) => s.seasonNumber) ?? null) : null,
    is4k: record.is4k,
    status: deriveStatus(record.status, record.id),
    requestedAt: record.createdAt,
    availableAt: record.media.mediaAddedAt ?? null,
    requester: toRequesterInfo(record.requestedBy),
  };
}

// ============================================================================
// SeerrService
// ============================================================================

export interface SeerrFetchResult {
  records: SeerrSyncRecord[];
  /** Records that failed Zod validation and were skipped (never fail the whole run - design §6). */
  skipped: number;
  /**
   * True iff every page was retrieved without hitting the hard safety cap AND
   * the total valid+skipped records processed equals the last fetched page's
   * reported `pageInfo.results` (design §6 step 6). Gates the prune step in
   * jobs/seerrSyncQueue.ts - a dropped/duplicated row from concurrent Seerr
   * writes during pagination must never be pruned as "gone".
   */
  paginationConsistent: boolean;
}

export interface SeerrTestConnectionResult {
  success: boolean;
  version?: string;
  userCount?: number;
  error?: string;
}

export class SeerrService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(url: string, apiKey: string) {
    // SSRF check before anything else - allows loopback/RFC1918 by design
    // (Tracearr probes servers on the local network), blocks link-local/
    // metadata ranges and non-http(s) schemes.
    assertSafeProbeUrl(url);

    if (!apiKey || apiKey.length < 1) {
      throw new Error('Seerr API key is required');
    }

    this.baseUrl = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /** Strips the API key from any string before it can reach a log line or an
   * error surfaced to the client (ADR 0005 - the key must never leak).
   * Public (SEERR-04) so jobs/seerrSyncQueue.ts can redact the sync path's
   * error messages too - classifyError() below is only used by
   * testConnection(), so redaction was previously not literally guaranteed
   * on every failure path (the only attacker-reachable text there is a
   * hostile response.statusText, e.g. a key echoed back as the HTTP reason
   * phrase - low impact, but the invariant should hold everywhere). */
  redact(message: string): string {
    return this.apiKey ? message.split(this.apiKey).join('<redacted>') : message;
  }

  private async requestJson(
    path: string,
    opts: { timeoutMs: number; maxRetries: number }
  ): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

      try {
        // redirect: 'manual' (SEC-02 precedent) - undici does NOT strip custom
        // headers cross-origin, so a 30x from the Seerr host would otherwise
        // forward X-Api-Key to an arbitrary target and perform an unvalidated
        // server-side GET, bypassing assertSafeProbeUrl's SSRF check.
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'manual',
        });
        // NOTE: the abort timer stays armed past this point (cleared in the
        // `finally` below) so it also covers response.json() below (SEC-03) -
        // a slow/endless body must not hang indefinitely or buffer unbounded
        // memory. Do not add an early clearTimeout(timeoutId) here.

        if (response.status === 401 || response.status === 403) {
          throw new SeerrAuthError(`Seerr rejected the API key (HTTP ${response.status})`);
        }
        // With redirect: 'manual', a same-origin-filtered redirect response has
        // type 'opaqueredirect' and status 0 - the real 3xx status/Location are
        // deliberately not exposed by the Fetch spec, so we key off `type`.
        if (response.type === 'opaqueredirect') {
          throw new SeerrInvalidResponseError(
            'Seerr returned a redirect - refusing to follow it (check the configured URL)'
          );
        }
        if (!response.ok) {
          throw new Error(`Seerr API error: ${response.status} ${response.statusText}`);
        }

        // Best-effort body-size cap (SEC-03 precedent) - only enforced when
        // the server sends Content-Length; a chunked/unknown-length body
        // still relies on the abort timer above to bound worst-case hang time.
        const contentLength = response.headers?.get?.('content-length');
        if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
          throw new SeerrInvalidResponseError(
            `Seerr response body (${contentLength} bytes) exceeds the ${MAX_RESPONSE_BYTES} byte limit`
          );
        }

        // A misconfigured URL commonly serves the Seerr web SPA's index.html
        // instead of erroring - treat a non-JSON body as a hard failure
        // rather than letting response.json() throw uninformatively.
        const contentType = response.headers?.get?.('content-type') ?? '';
        if (contentType && !contentType.includes('application/json')) {
          throw new SeerrInvalidResponseError('Seerr returned a non-JSON response (check the URL)');
        }

        try {
          return await response.json();
        } catch (parseError) {
          // A body-read abort (SEC-03 - the timer now covers response.json())
          // must fall through to the outer AbortError handling below so it is
          // classified/retried as a timeout, not mislabeled as a parse failure.
          if (parseError instanceof Error && parseError.name === 'AbortError') {
            throw parseError;
          }
          throw new SeerrInvalidResponseError(
            'Seerr returned a response that could not be parsed as JSON (check the URL)'
          );
        }
      } catch (error) {
        // Never retry - retrying gets the same auth failure or the same body again.
        if (error instanceof SeerrAuthError || error instanceof SeerrInvalidResponseError) {
          throw error;
        }

        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Seerr request timed out after ${opts.timeoutMs}ms`);
        } else {
          lastError = error instanceof Error ? error : new Error('Unknown error');
        }

        if (attempt < opts.maxRetries) {
          const delay = RETRY_DELAY_MS * attempt;
          console.warn(
            `[Seerr] Request to ${path} failed (attempt ${attempt}/${opts.maxRetries}), retrying in ${delay}ms: ${this.redact(lastError.message)}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        // Cleared exactly once per attempt, after the body has been fully
        // consumed (success or failure) - not right after headers (SEC-03).
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error('Seerr request failed after retries');
  }

  /** Classifies a thrown error into a human-readable, key-redacted cause string. */
  private classifyError(error: unknown): string {
    if (error instanceof SsrfBlockedError) return error.message;
    if (error instanceof SeerrAuthError) return 'Invalid Seerr API key';
    if (error instanceof SeerrInvalidResponseError) return error.message;
    const message = error instanceof Error ? error.message : 'Unknown error connecting to Seerr';
    return this.redact(message);
  }

  /**
   * POST /seerr/test-connection backing call - contract §2. Two calls, since
   * GET /api/v1/status is typically unauthenticated in the Overseerr lineage
   * and cannot validate the key by itself:
   *   1. GET /api/v1/status - reachability + version (best-effort; a parse
   *      failure here does not fail the overall check, only the version is lost).
   *   2. GET /api/v1/user?take=1 with X-Api-Key - key validity + admin scope;
   *      pageInfo.results supplies userCount. Payload never returned or logged.
   * `version`/`userCount` are present ONLY on overall success (contract §2).
   */
  async testConnection(): Promise<SeerrTestConnectionResult> {
    let version: string | undefined;

    try {
      const statusJson = await this.requestJson('/api/v1/status', {
        timeoutMs: SEERR_TEST_CONNECTION_TIMEOUT_MS,
        maxRetries: 1, // no retries on the interactive check (contract §2)
      });
      const parsedStatus = seerrStatusEndpointSchema.safeParse(statusJson);
      if (parsedStatus.success) {
        version = parsedStatus.data.version;
      }
    } catch (error) {
      // Reachability failure (network/DNS/timeout/non-JSON) - cannot even
      // reach the instance, so the key-validity call is pointless.
      return { success: false, error: this.classifyError(error) };
    }

    try {
      const userJson = await this.requestJson('/api/v1/user?take=1', {
        timeoutMs: SEERR_TEST_CONNECTION_TIMEOUT_MS,
        maxRetries: 1,
      });
      const parsedUsers = seerrUserListSchema.safeParse(userJson);
      if (!parsedUsers.success) {
        return { success: false, error: 'Seerr returned an unexpected response format' };
      }
      return { success: true, version, userCount: parsedUsers.data.pageInfo.results };
    } catch (error) {
      return { success: false, error: this.classifyError(error) };
    }
  }

  /** Fetches + validates GET /api/v1/request/count - cheap totals used as a
   * progress denominator (design §6 step 3). Never blocks the run: a failure
   * here is caught and logged by the caller, the fetch phase is authoritative. */
  async getRequestCount(): Promise<SeerrRequestCount> {
    const json = await this.requestJson('/api/v1/request/count', {
      timeoutMs: SEERR_SYNC_TIMEOUT_MS,
      maxRetries: SEERR_MAX_RETRIES,
    });

    const parsed = seerrCountSchema.safeParse(json);
    if (!parsed.success) {
      throw new SeerrInvalidResponseError('Seerr request-count payload was not the expected shape');
    }
    return parsed.data;
  }

  /**
   * Fetches + validates all pages of GET /api/v1/request (design §6) - one
   * endpoint serves movie+tv, unlike Ombi's split endpoints. Per-record
   * validation with skip-on-failure (never abort the run for one malformed
   * row); in-memory dedupe by request id (offset paging can duplicate a row
   * if requests land mid-iteration); hard page cap
   * min(ceil(pageInfo.results / take) + 1, MAX_PAGES) guards against a
   * pathological/moving total that never lets the loop terminate - bounded
   * by the absolute MAX_PAGES ceiling (SEERR-01), since a cap computed ONLY
   * from the reported total scales right along with a hostile value and
   * never actually bounds anything.
   */
  async fetchAllRequests(): Promise<SeerrFetchResult> {
    const collected = new Map<number, SeerrSyncRecord>();
    let skipped = 0;
    let skip = 0;
    let pagesFetched = 0;
    let lastReportedTotal: number;
    let hitHardCap = false;

    for (;;) {
      const json = await this.requestJson(`/api/v1/request?take=${SEERR_PAGE_SIZE}&skip=${skip}`, {
        timeoutMs: SEERR_SYNC_TIMEOUT_MS,
        maxRetries: SEERR_MAX_RETRIES,
      });

      const topLevel = seerrRequestListSchema.safeParse(json);
      if (!topLevel.success) {
        throw new SeerrInvalidResponseError(
          'Seerr request payload was not the expected paginated shape'
        );
      }

      const { pageInfo, results } = topLevel.data;
      lastReportedTotal = pageInfo.results;
      pagesFetched++;

      for (const raw of results) {
        const parsed = seerrRequestSchema.safeParse(raw);
        if (!parsed.success) {
          const id = (raw as Record<string, unknown> | null)?.id ?? 'unknown';
          console.warn(
            `[Seerr] Skipping malformed request ${String(id)}: ${parsed.error.issues[0]?.message ?? 'validation failed'}`
          );
          skipped++;
          continue;
        }
        const mapped = mapRequestRecord(parsed.data);
        // Keyed by request id - a later duplicate (moving-offset artifact)
        // simply overwrites the earlier copy, harmless since it's the same request.
        collected.set(mapped.seerrRequestId, mapped);
      }

      // Stop when this page came back empty (nothing more to read) or we've
      // paged past the reported total.
      if (results.length === 0 || skip + results.length >= pageInfo.results) {
        break;
      }

      // Hard cap (SEERR-01): bounded by the ABSOLUTE MAX_PAGES ceiling, not
      // just the total-derived figure - pageInfo.results is attacker-
      // controlled, so a cap computed only from it (the pre-fix behavior)
      // scales right along with a hostile value and never actually
      // terminates the loop. min(...) is what makes this a real guard.
      const hardCap = Math.min(Math.ceil(pageInfo.results / SEERR_PAGE_SIZE) + 1, MAX_PAGES);
      if (pagesFetched >= hardCap) {
        hitHardCap = true;
        break;
      }

      skip += SEERR_PAGE_SIZE;
    }

    const processedCount = collected.size + skipped;
    const paginationConsistent = !hitHardCap && processedCount === lastReportedTotal;

    return { records: Array.from(collected.values()), skipped, paginationConsistent };
  }
}
