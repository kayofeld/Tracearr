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
  id: z.string(),
  userName: z.string(),
  alias: z.string().nullable().optional(),
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
  imdbId: z.string().nullable().optional(),
  title: z.string(),
  releaseDate: z.coerce.date().nullable().optional(),
  requestedDate: z.coerce.date(),
  requestedUser: ombiRequestedUserSchema,
  requestedByAlias: z.string().nullable().optional(),
  approved: z.boolean().default(false),
  denied: z.boolean().default(false),
  available: z.boolean().default(false),
  markedAsAvailable: z.coerce.date().nullable().optional(),
  is4kRequest: z.boolean().default(false),
});

const ombiSeasonRequestSchema = z.object({
  seasonNumber: z.number(),
});

const ombiChildRequestSchema = z.object({
  id: z.number(),
  parentRequestId: z.number(),
  requestedDate: z.coerce.date(),
  requestedUser: ombiRequestedUserSchema,
  approved: z.boolean().default(false),
  denied: z.boolean().default(false),
  available: z.boolean().default(false),
  markedAsAvailable: z.coerce.date().nullable().optional(),
  seasonRequests: z.array(ombiSeasonRequestSchema).nullable().optional(),
  releaseYear: z.number().nullable().optional(),
});

/** Parent-level structural check only - childRequests are validated per-element
 * so one malformed child never drops its siblings (design §5 step 3-4). */
const ombiTvParentSchema = z.object({
  id: z.number(),
  tvDbId: z.number().nullable().optional(),
  imdbId: z.string().nullable().optional(),
  title: z.string(),
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
      ombiAlias: record.requestedUser.alias?.trim()
        ? record.requestedUser.alias
        : (record.requestedByAlias ?? null),
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
   * error surfaced to the client (ADR 0005 - the key must never leak). */
  private redact(message: string): string {
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
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { ApiKey: this.apiKey, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 401 || response.status === 403) {
          throw new OmbiAuthError(`Ombi rejected the API key (HTTP ${response.status})`);
        }
        if (!response.ok) {
          throw new Error(`Ombi API error: ${response.status} ${response.statusText}`);
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
        } catch {
          throw new OmbiInvalidResponseError(
            'Ombi returned a response that could not be parsed as JSON (check the URL)'
          );
        }
      } catch (error) {
        clearTimeout(timeoutId);

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
