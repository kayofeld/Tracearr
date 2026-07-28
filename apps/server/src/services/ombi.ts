/**
 * Ombi API client
 *
 * Outbound HTTP client for the Ombi connector. Owns request/response validation
 * (Zod) and mapping Ombi's payload shapes into the internal sync record shape
 * consumed by jobs/ombiSyncQueue.ts. Resolution (Ombi requester -> Tracearr
 * user), persistence, and orchestration live in the sync job - this module
 * only talks to Ombi.
 *
 * Contract: docs/architecture/ombi-api-contract.md §2-3, §5.1-5.3.
 * Design: docs/architecture/ombi-connector.md §1 (verified ground truth), §5.
 * Model/precedent: services/tautulli.ts (retry/timeout/Zod-validation shape).
 */

import { z } from 'zod';
import { assertSafeProbeUrl, SsrfBlockedError } from '../utils/ssrf.js';

// ============================================================================
// Timing / retry configuration
// ============================================================================

/** 30s timeout for sync fetches (movie/tv payloads can be several MB). */
export const OMBI_SYNC_TIMEOUT_MS = 30_000;
/** 10s timeout for the interactive test-connection check. */
export const OMBI_TEST_CONNECTION_TIMEOUT_MS = 10_000;
/** 3 attempts, linear backoff (1s, 2s), matches services/tautulli.ts. */
export const OMBI_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
/** Response body cap (SEC-03) - payloads are measured at 1.5-3.4MB; 50MB is a
 * generous ceiling that still bounds unbounded memory growth from a hostile
 * or misbehaving server. Best-effort: only enforced when Content-Length is sent. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

// ============================================================================
// Column-width caps (SEC-05) - mirrors db/schema.ts `ombi_requests` /
// `ombi_user_mappings` varchar widths. Zod strings are otherwise uncapped
// while the Postgres columns are fixed-width, so a single over-long value
// throws at insert and rolls back the WHOLE per-media-type transaction,
// silently stalling the mirror. Identifiers used for joins/matching are
// SKIPPED when oversized (never truncated - a truncated join key corrupts
// matching); free-text display fields are TRUNCATED so the record still
// syncs.
// ============================================================================
const TITLE_MAX = 500; // ombi_requests.title
const DISPLAY_NAME_MAX = 255; // ombi_requests.ombi_username / ombi_alias
const IMDB_ID_MAX = 20; // ombi_requests.imdb_id

const OMBI_USER_ID_MAX = 64; // ombi_requests.ombi_user_id / ombi_user_mappings.ombi_user_id

/**
 * Ombi sends explicit `null` for unset booleans: `denied` is null on 279 of 280
 * TV child requests and on 2 of 658 movies in the reference instance.
 * `z.boolean().default(false)` does NOT cover that - a Zod default only applies
 * to `undefined` - so every one of those records failed validation and was
 * skipped, which dropped 100% of TV requests on the first live sync.
 */
const ombiBoolean = () =>
  z
    .boolean()
    .nullish()
    .transform((v) => v ?? false);

/**
 * `releaseYear` on TV children is NOT a year: Ombi sends a date string, and in
 * the reference instance it is the .NET default "0001-01-01T00:00:00Z" on all
 * 280 children - i.e. never actually populated. Accept either shape and discard
 * implausible values so a placeholder never surfaces as "year 1" in the UI.
 */
const ombiReleaseYear = () =>
  z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const year = typeof v === 'number' ? v : new Date(v).getUTCFullYear();
      return Number.isFinite(year) && year >= 1900 ? year : null;
    });

// ============================================================================
// Errors
// ============================================================================

/** Ombi rejected the API key (401/403) - never retried, retrying won't fix bad credentials. */
export class OmbiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmbiAuthError';
  }
}

/**
 * Ombi returned something that isn't the expected JSON shape - most commonly its
 * SPA index.html served as a fallback for an unpaged/unknown route (a real,
 * observed failure mode: paged Request/movie variants 404 to the SPA rather
 * than erroring). Never retried - retrying gets the same HTML again.
 */
export class OmbiInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmbiInvalidResponseError';
  }
}

// ============================================================================
// Zod schemas - Ombi 4.47.1 payload shapes (verified ground truth, see design §1)
// ============================================================================

const ombiRequestedUserSchema = z.object({
  // Identifier (ombi_user_id) - oversized values fail validation so the
  // record is skipped rather than truncated (SEC-05: never corrupt a join key).
  id: z.string().max(OMBI_USER_ID_MAX),
  userName: z.string().transform((s) => s.slice(0, DISPLAY_NAME_MAX)),
  alias: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
  email: z.string().nullable().optional(),
  userType: z.number().nullable().optional(),
  providerUserId: z.string().nullable().optional(),
});

/** requestedDate/markedAsAvailable arrive as ISO-8601 UTC with 7 fractional digits
 * (e.g. "2025-03-03T09:07:45.3107886Z"). z.coerce.date() -> `new Date(...)`,
 * which parses (and safely truncates) this without a custom parser. */
const ombiMovieRequestSchema = z.object({
  id: z.number(),
  theMovieDbId: z.number().nullable().optional(),
  // Identifier - oversized value fails validation, record is skipped (SEC-05).
  imdbId: z.string().max(IMDB_ID_MAX).nullable().optional(),
  title: z.string().transform((s) => s.slice(0, TITLE_MAX)),
  releaseDate: z.coerce.date().nullable().optional(),
  requestedDate: z.coerce.date(),
  requestedUser: ombiRequestedUserSchema,
  requestedByAlias: z
    .string()
    .transform((s) => s.slice(0, DISPLAY_NAME_MAX))
    .nullable()
    .optional(),
  approved: ombiBoolean(),
  denied: ombiBoolean(),
  available: ombiBoolean(),
  markedAsAvailable: z.coerce.date().nullable().optional(),
  is4kRequest: ombiBoolean(),
});

const ombiSeasonRequestSchema = z.object({
  seasonNumber: z.number(),
});

const ombiChildRequestSchema = z.object({
  id: z.number(),
  parentRequestId: z.number(),
  requestedDate: z.coerce.date(),
  requestedUser: ombiRequestedUserSchema,
  approved: ombiBoolean(),
  denied: ombiBoolean(),
  available: ombiBoolean(),
  markedAsAvailable: z.coerce.date().nullable().optional(),
  seasonRequests: z.array(ombiSeasonRequestSchema).nullable().optional(),
  releaseYear: ombiReleaseYear(),
});

/** Parent-level structural check only - childRequests are validated per-element
 * so one malformed child never drops its siblings (design §5 step 3-4). */
const ombiTvParentSchema = z.object({
  id: z.number(),
  tvDbId: z.number().nullable().optional(),
  // Identifier - oversized value fails validation, record is skipped (SEC-05).
  imdbId: z.string().max(IMDB_ID_MAX).nullable().optional(),
  title: z.string().transform((s) => s.slice(0, TITLE_MAX)),
});

export type OmbiMovieRequest = z.infer<typeof ombiMovieRequestSchema>;
export type OmbiChildRequest = z.infer<typeof ombiChildRequestSchema>;

// ============================================================================
// Internal sync record - the shape jobs/ombiSyncQueue.ts consumes
// ============================================================================

export interface OmbiRawRequesterInfo {
  ombiUserId: string;
  ombiUsername: string;
  ombiAlias: string | null;
  /** Transient only - never persisted (design §7 PII decision). Used solely
   * for the provider-id resolution tier during a live sync. */
  providerUserId: string | null;
}

export interface OmbiSyncRecord {
  ombiRequestId: number;
  ombiParentRequestId: number | null;
  mediaType: 'movie' | 'tv';
  title: string;
  releaseYear: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  seasons: number[] | null;
  is4k: boolean;
  status: 'pending' | 'approved' | 'denied' | 'available';
  requestedAt: Date;
  availableAt: Date | null;
  requester: OmbiRawRequesterInfo;
}

/** Derives the single status enum from Ombi's four booleans (design §4.1). */
function deriveStatus(flags: {
  available: boolean;
  denied: boolean;
  approved: boolean;
}): OmbiSyncRecord['status'] {
  if (flags.available) return 'available';
  if (flags.denied) return 'denied';
  if (flags.approved) return 'approved';
  return 'pending';
}

function toRequesterInfo(user: z.infer<typeof ombiRequestedUserSchema>): OmbiRawRequesterInfo {
  return {
    ombiUserId: user.id,
    ombiUsername: user.userName,
    ombiAlias: user.alias?.trim() ? user.alias : null,
    providerUserId: user.providerUserId?.trim() ? user.providerUserId : null,
  };
}

function mapMovieRecord(record: OmbiMovieRequest): OmbiSyncRecord {
  return {
    ombiRequestId: record.id,
    ombiParentRequestId: null,
    mediaType: 'movie',
    title: record.title,
    releaseYear: record.releaseDate ? record.releaseDate.getUTCFullYear() : null,
    imdbId: record.imdbId ?? null,
    tmdbId: record.theMovieDbId ?? null,
    tvdbId: null,
    seasons: null,
    is4k: record.is4kRequest,
    status: deriveStatus(record),
    requestedAt: record.requestedDate,
    availableAt: record.markedAsAvailable ?? null,
    requester: {
      ...toRequesterInfo(record.requestedUser),
      // requestedByAlias is a secondary field Ombi carries at top level; prefer
      // the requestedUser.alias (design §4.1: "preferred fallback display name").
      // Ombi commonly sends requestedByAlias: "" - treat blank as absent so an
      // empty string never wins over null and renders as a blank requester name
      // (OMB-1; both UI sites do `ombiAlias ?? ombiUsername`, so "" ?? null keeps "").
      ombiAlias: record.requestedUser.alias?.trim()
        ? record.requestedUser.alias
        : record.requestedByAlias?.trim()
          ? record.requestedByAlias
          : null,
    },
  };
}

function mapChildRecord(
  child: OmbiChildRequest,
  parent: z.infer<typeof ombiTvParentSchema>
): OmbiSyncRecord {
  return {
    ombiRequestId: child.id,
    ombiParentRequestId: parent.id,
    mediaType: 'tv',
    // Denormalized from the PARENT (ground truth: rows carry the parent's
    // tvDbId/imdbId/title - see docs/architecture/ombi-connector.md §1).
    title: parent.title,
    releaseYear: child.releaseYear ?? null,
    imdbId: parent.imdbId ?? null,
    tmdbId: null,
    tvdbId: parent.tvDbId ?? null,
    seasons: child.seasonRequests?.map((s) => s.seasonNumber) ?? null,
    is4k: false,
    status: deriveStatus(child),
    requestedAt: child.requestedDate,
    availableAt: child.markedAsAvailable ?? null,
    requester: toRequesterInfo(child.requestedUser),
  };
}

// ============================================================================
// OmbiService
// ============================================================================

export interface OmbiFetchResult {
  records: OmbiSyncRecord[];
  /** Records that failed Zod validation and were skipped (never fail the whole run - design §5). */
  skipped: number;
}

export class OmbiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(url: string, apiKey: string) {
    // SSRF check before anything else - allows loopback/RFC1918 by design
    // (Tracearr probes servers on the local network), blocks link-local/
    // metadata ranges and non-http(s) schemes. Also the URL-parseability
    // check (assertSafeProbeUrl throws SsrfBlockedError('Malformed URL: ...')
    // for anything `new URL()` can't parse), so no separate check is needed.
    assertSafeProbeUrl(url);

    if (!apiKey || apiKey.length < 1) {
      throw new Error('Ombi API key is required');
    }

    this.baseUrl = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /** Strips the API key from any string before it can reach a log line or an
   * error surfaced to the client (ADR 0005 - the key must never leak).
   * Public (SEERR-04 sibling fix) so jobs/ombiSyncQueue.ts can redact the
   * sync path's error messages too - classifyError() below is only used by
   * testConnection(), so redaction was previously not literally guaranteed
   * on every failure path. */
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
        // redirect: 'manual' (SEC-02) - undici does NOT strip custom headers
        // cross-origin, so a 30x from the Ombi host would otherwise forward
        // the ApiKey header to an arbitrary target and perform an unvalidated
        // server-side GET, bypassing assertSafeProbeUrl's SSRF check. Ombi API
        // endpoints don't legitimately redirect, so treat any redirect as an error.
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { ApiKey: this.apiKey, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'manual',
        });
        // NOTE: the abort timer stays armed past this point (cleared in the
        // `finally` below) so it also covers response.json() below (SEC-03) -
        // a slow/endless body must not hang indefinitely or buffer unbounded
        // memory. Do not add an early clearTimeout(timeoutId) here.

        if (response.status === 401 || response.status === 403) {
          throw new OmbiAuthError(`Ombi rejected the API key (HTTP ${response.status})`);
        }
        // With redirect: 'manual', a same-origin-filtered redirect response has
        // type 'opaqueredirect' and status 0 - the real 3xx status/Location are
        // deliberately not exposed by the Fetch spec, so we key off `type`.
        if (response.type === 'opaqueredirect') {
          throw new OmbiInvalidResponseError(
            'Ombi returned a redirect - refusing to follow it (check the configured URL)'
          );
        }
        if (!response.ok) {
          throw new Error(`Ombi API error: ${response.status} ${response.statusText}`);
        }

        // Best-effort body-size cap (SEC-03) - only enforced when the server
        // sends Content-Length; a chunked/unknown-length body still relies on
        // the abort timer above to bound worst-case hang time.
        const contentLength = response.headers?.get?.('content-length');
        if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
          throw new OmbiInvalidResponseError(
            `Ombi response body (${contentLength} bytes) exceeds the ${MAX_RESPONSE_BYTES} byte limit`
          );
        }

        // Ombi's SPA serves index.html for unknown/paged routes instead of
        // erroring (verified ground truth) - treat a non-JSON body as a hard
        // failure rather than letting response.json() throw uninformatively.
        const contentType = response.headers?.get?.('content-type') ?? '';
        if (contentType && !contentType.includes('application/json')) {
          throw new OmbiInvalidResponseError(
            'Ombi returned a non-JSON response (check the URL - paged/unknown routes fall through to the web UI)'
          );
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
          throw new OmbiInvalidResponseError(
            'Ombi returned a response that could not be parsed as JSON (check the URL)'
          );
        }
      } catch (error) {
        // Never retry - retrying gets the same auth failure or the same HTML again.
        if (error instanceof OmbiAuthError || error instanceof OmbiInvalidResponseError) {
          throw error;
        }

        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Ombi request timed out after ${opts.timeoutMs}ms`);
        } else {
          lastError = error instanceof Error ? error : new Error('Unknown error');
        }

        if (attempt < opts.maxRetries) {
          const delay = RETRY_DELAY_MS * attempt;
          console.warn(
            `[Ombi] Request to ${path} failed (attempt ${attempt}/${opts.maxRetries}), retrying in ${delay}ms: ${this.redact(lastError.message)}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        // Cleared exactly once per attempt, after the body has been fully
        // consumed (success or failure) - not right after headers (SEC-03).
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error('Ombi request failed after retries');
  }

  /** Classifies a thrown error into a human-readable, key-redacted cause string. */
  private classifyError(error: unknown): string {
    if (error instanceof SsrfBlockedError) return error.message;
    if (error instanceof OmbiAuthError) return 'Invalid Ombi API key';
    if (error instanceof OmbiInvalidResponseError) return error.message;
    const message = error instanceof Error ? error.message : 'Unknown error connecting to Ombi';
    return this.redact(message);
  }

  /**
   * POST /ombi/test-connection backing call - contract §2.
   * GET /api/v1/Identity/Users requires admin scope, which sync also needs,
   * so this doubles as both a reachability and a permission check. The user
   * payload is counted, never returned or logged.
   */
  async testConnection(): Promise<{ success: boolean; userCount?: number; error?: string }> {
    try {
      const json = await this.requestJson('/api/v1/Identity/Users', {
        timeoutMs: OMBI_TEST_CONNECTION_TIMEOUT_MS,
        maxRetries: 1, // no retries on the interactive check (contract §2)
      });
      const parsed = z.array(z.unknown()).safeParse(json);
      if (!parsed.success) {
        return { success: false, error: 'Ombi returned an unexpected response format' };
      }
      return { success: true, userCount: parsed.data.length };
    } catch (error) {
      return { success: false, error: this.classifyError(error) };
    }
  }

  /** Fetches + validates GET /api/v1/Request/movie (unpaged, ~658 records measured). */
  async getMovieRequests(): Promise<OmbiFetchResult> {
    const json = await this.requestJson('/api/v1/Request/movie', {
      timeoutMs: OMBI_SYNC_TIMEOUT_MS,
      maxRetries: OMBI_MAX_RETRIES,
    });

    const topLevel = z.array(z.unknown()).safeParse(json);
    if (!topLevel.success) {
      throw new OmbiInvalidResponseError('Ombi movie request payload was not an array');
    }

    let skipped = 0;
    const records: OmbiSyncRecord[] = [];
    for (const raw of topLevel.data) {
      const parsed = ombiMovieRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as Record<string, unknown> | null)?.id ?? 'unknown';
        console.warn(
          `[Ombi] Skipping malformed movie request ${id}: ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
        skipped++;
        continue;
      }
      records.push(mapMovieRecord(parsed.data));
    }

    return { records, skipped };
  }

  /**
   * Fetches + validates GET /api/v1/Request/tv (unpaged, ~274 parents measured),
   * flattening childRequests[] into one record per child (design §4.1 - a TV
   * "request" for attribution purposes is the per-user, per-season-batch child).
   */
  async getTvRequests(): Promise<OmbiFetchResult> {
    const json = await this.requestJson('/api/v1/Request/tv', {
      timeoutMs: OMBI_SYNC_TIMEOUT_MS,
      maxRetries: OMBI_MAX_RETRIES,
    });

    const topLevel = z.array(z.unknown()).safeParse(json);
    if (!topLevel.success) {
      throw new OmbiInvalidResponseError('Ombi TV request payload was not an array');
    }

    let skipped = 0;
    const records: OmbiSyncRecord[] = [];
    for (const rawParent of topLevel.data) {
      const parentParsed = ombiTvParentSchema.safeParse(rawParent);
      const rawChildren = (rawParent as Record<string, unknown> | null)?.childRequests;
      const childCount = Array.isArray(rawChildren) ? rawChildren.length : 1;

      if (!parentParsed.success) {
        const id = (rawParent as Record<string, unknown> | null)?.id ?? 'unknown';
        console.warn(
          `[Ombi] Skipping malformed TV parent request ${id}: ${parentParsed.error.issues[0]?.message ?? 'validation failed'}`
        );
        skipped += childCount;
        continue;
      }

      if (!Array.isArray(rawChildren)) {
        continue; // no children - nothing to attribute for this series
      }

      for (const rawChild of rawChildren) {
        const childParsed = ombiChildRequestSchema.safeParse(rawChild);
        if (!childParsed.success) {
          const id = (rawChild as Record<string, unknown> | null)?.id ?? 'unknown';
          console.warn(
            `[Ombi] Skipping malformed TV child request ${id} (parent ${parentParsed.data.id}): ${childParsed.error.issues[0]?.message ?? 'validation failed'}`
          );
          skipped++;
          continue;
        }
        records.push(mapChildRecord(childParsed.data, parentParsed.data));
      }
    }

    return { records, skipped };
  }
}
