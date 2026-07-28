/**
 * Ombi Sync Queue - BullMQ-based full-mirror resync of Ombi media requests
 *
 * Full fetch + upsert + prune every run (ADR 0004) - both Ombi endpoints are
 * unpaged, so there is no cheaper incremental path. Movies and TV are
 * independent phases/transactions: a TV failure leaves a completed movie
 * phase intact.
 *
 * Requester -> Tracearr user resolution (ADR 0002): manual override ->
 * providerUserId -> case-insensitive username -> unattributed, recomputed
 * every run. A mapping change re-resolves immediately without a full sync
 * (see resolveOneRequester, called from routes/ombi.ts).
 *
 * Unconfigured = complete no-op: the repeatable scheduler is always
 * registered (so configure/disconnect takes effect without a restart -
 * settings are read fresh on every firing, jobs/telegramCommandListener.ts
 * pattern), but a firing with no ombiUrl/ombiApiKey returns immediately with
 * zero DB writes, zero network calls, and zero log output.
 *
 * Model/precedent: jobs/librarySyncQueue.ts (queue/worker shape, cache
 * invalidation pattern), jobs/plexTokenRefresh.ts (pure business-logic
 * function separated from BullMQ plumbing for direct unit testing).
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { getRedisPrefix, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import type { OmbiSyncProgressEvent } from '@tracearr/shared';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { mediaRequests, mediaRequestUserMappings, serverUsers, users } from '../db/schema.js';
import { getPubSubService } from '../services/cache.js';
import { getOmbiSettings, getSetting, setSetting } from '../services/settings.js';
import type { OmbiSyncStatusInternal } from '../services/settings.js';
import { OmbiService, type OmbiRawRequesterInfo, type OmbiSyncRecord } from '../services/ombi.js';

const QUEUE_NAME = 'ombi-sync';
const SCHEDULER_JOB_ID = 'ombi-scheduled-sync';

export interface OmbiSyncJobData {
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // audit trail for manual syncs
}

let connectionOptions: ConnectionOptions | null = null;
let ombiSyncQueue: Queue<OmbiSyncJobData> | null = null;
let ombiSyncWorker: Worker<OmbiSyncJobData> | null = null;
let redisClient: Redis | null = null;

// ============================================================================
// Cache invalidation (design §5 step 6, §8) - exported so routes/ombi.ts can
// call it directly after a mapping change or a purge, without waiting for a sync.
// ============================================================================

export async function invalidateOmbiCaches(redis: Redis): Promise<void> {
  const patterns = [`${REDIS_KEYS.LIBRARY_STALE}*`, `${REDIS_KEYS.OMBI_REQUESTER_STATS}*`];

  let totalDeleted = 0;
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
  }

  if (totalDeleted > 0) {
    console.log(`[OmbiSync] Invalidated ${totalDeleted} cache keys`);
  }
}

// ============================================================================
// Requester resolution (ADR 0002)
// ============================================================================

export interface RequesterResolution {
  userId: string | null;
  matchMethod: 'manual' | 'provider' | 'username' | null;
}

export interface RequesterResolver {
  resolve(info: OmbiRawRequesterInfo): RequesterResolution;
}

/**
 * Builds the resolution maps once per sync run (three cheap queries at this
 * volume - dozens of users/mappings, not per-request lookups).
 *
 * Passing providerUserId: null to resolve() skips tier 2 entirely - used by
 * the live single-requester re-resolution path (routes/ombi.ts mapping PUT/
 * DELETE), which has no live Ombi payload to read providerUserId from
 * (it is intentionally never persisted - design §7 PII minimization).
 */
export async function buildRequesterResolver(): Promise<RequesterResolver> {
  const [mappingRows, serverUserRows, userRows] = await Promise.all([
    db
      .select({
        ombiUserId: mediaRequestUserMappings.sourceUserId,
        userId: mediaRequestUserMappings.userId,
      })
      .from(mediaRequestUserMappings)
      .where(eq(mediaRequestUserMappings.source, 'ombi')),
    db
      .select({ plexAccountId: serverUsers.plexAccountId, userId: serverUsers.userId })
      .from(serverUsers)
      .where(isNotNull(serverUsers.plexAccountId)),
    db.select({ id: users.id, username: users.username }).from(users),
  ]);

  const manualMap = new Map<string, string | null>(
    mappingRows.map((r) => [r.ombiUserId, r.userId])
  );

  const providerMap = new Map<string, string>();
  for (const row of serverUserRows) {
    if (row.plexAccountId) providerMap.set(row.plexAccountId, row.userId);
  }

  const usernameMap = new Map<string, string[]>();
  for (const row of userRows) {
    const key = row.username.toLowerCase();
    const arr = usernameMap.get(key) ?? [];
    arr.push(row.id);
    usernameMap.set(key, arr);
  }

  return {
    resolve({ ombiUserId, ombiUsername, providerUserId }): RequesterResolution {
      // Tier 1: manual override. userId===null on the mapping row means the
      // owner explicitly forced this requester to stay unattributed.
      if (manualMap.has(ombiUserId)) {
        return { userId: manualMap.get(ombiUserId) ?? null, matchMethod: 'manual' };
      }

      // Tier 2: provider id (Plex-OAuth Ombi accounts). Zero matches measured
      // today - future-proofing, costs one condition (ADR 0002 §6.2 step 2).
      if (providerUserId) {
        const uid = providerMap.get(providerUserId);
        if (uid) return { userId: uid, matchMethod: 'provider' };
      }

      // Tier 3: case-insensitive username. Ambiguous (>1 candidate) refuses
      // to guess and falls through to unattributed.
      const candidates = usernameMap.get(ombiUsername.toLowerCase());
      const soleCandidate = candidates?.length === 1 ? candidates[0] : undefined;
      if (soleCandidate) {
        return { userId: soleCandidate, matchMethod: 'username' };
      }

      return { userId: null, matchMethod: null };
    },
  };
}

// ============================================================================
// Upsert + prune (ADR 0004)
// ============================================================================

interface PhaseResult {
  ok: boolean;
  processed: number;
  skipped: number;
  pruned: number;
  error: string | null;
}

// CR-3 sibling fix (jobs/seerrSyncQueue.ts): node-postgres caps a single bind
// message at 65,535 parameters; each row here binds ~20 values, so one
// unchunked multi-row INSERT hard-fails around ~3,200 requests per phase.
// Less urgent here (movies/tv are independent phases, so the practical
// per-phase row count is roughly half Seerr's single-phase count), but the
// same exposure exists, so fixed the same way.
const INSERT_CHUNK_SIZE = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function emptyPhase(error: string | null = null): PhaseResult {
  return { ok: error === null, processed: 0, skipped: 0, pruned: 0, error };
}

async function upsertPhase(
  mediaType: 'movie' | 'tv',
  records: OmbiSyncRecord[],
  resolver: RequesterResolver,
  runStartedAt: Date,
  allowPrune: boolean
): Promise<{ processed: number; pruned: number }> {
  let pruned = 0;

  if (records.length > 0) {
    const rows = records.map((r) => {
      const resolution = resolver.resolve(r.requester);
      return {
        source: 'ombi' as const,
        sourceRequestId: r.ombiRequestId,
        sourceParentRequestId: r.ombiParentRequestId,
        mediaType: r.mediaType,
        title: r.title,
        releaseYear: r.releaseYear,
        imdbId: r.imdbId,
        tmdbId: r.tmdbId,
        tvdbId: r.tvdbId,
        seasons: r.seasons,
        is4k: r.is4k,
        status: r.status,
        requestedAt: r.requestedAt,
        availableAt: r.availableAt,
        sourceUserId: r.requester.ombiUserId,
        sourceUsername: r.requester.ombiUsername,
        sourceAlias: r.requester.ombiAlias,
        userId: resolution.userId,
        matchMethod: resolution.matchMethod,
        syncedAt: runStartedAt,
      };
    });

    await db.transaction(async (tx) => {
      // Chunked (CR-3 sibling fix) - all chunks run inside this one
      // transaction, same as the prune below: still all-or-nothing per phase.
      for (const rowChunk of chunk(rows, INSERT_CHUNK_SIZE)) {
        await tx
          .insert(mediaRequests)
          .values(rowChunk)
          .onConflictDoUpdate({
            target: [mediaRequests.source, mediaRequests.mediaType, mediaRequests.sourceRequestId],
            set: {
              sourceParentRequestId: sqlExcluded('source_parent_request_id'),
              title: sqlExcluded('title'),
              releaseYear: sqlExcluded('release_year'),
              imdbId: sqlExcluded('imdb_id'),
              tmdbId: sqlExcluded('tmdb_id'),
              tvdbId: sqlExcluded('tvdb_id'),
              seasons: sqlExcluded('seasons'),
              is4k: sqlExcluded('is_4k'),
              status: sqlExcluded('status'),
              requestedAt: sqlExcluded('requested_at'),
              availableAt: sqlExcluded('available_at'),
              sourceUserId: sqlExcluded('source_user_id'),
              sourceUsername: sqlExcluded('source_username'),
              sourceAlias: sqlExcluded('source_alias'),
              userId: sqlExcluded('user_id'),
              matchMethod: sqlExcluded('match_method'),
              syncedAt: sqlExcluded('synced_at'),
              updatedAt: new Date(),
            },
          });
      }

      if (allowPrune) {
        const deleted = await tx
          .delete(mediaRequests)
          .where(
            and(
              eq(mediaRequests.source, 'ombi'),
              eq(mediaRequests.mediaType, mediaType),
              lt(mediaRequests.syncedAt, runStartedAt)
            )
          )
          .returning({ id: mediaRequests.id });
        pruned = deleted.length;
      }
    });
  } else if (allowPrune) {
    // Zero live records this run (e.g. the owner deleted everything in Ombi) -
    // every existing row of this type, FOR THIS SOURCE, is now stale and should
    // be pruned too. Scoped to source='ombi' so a Seerr-only run never touches
    // Ombi rows and vice versa.
    const deleted = await db
      .delete(mediaRequests)
      .where(
        and(
          eq(mediaRequests.source, 'ombi'),
          eq(mediaRequests.mediaType, mediaType),
          lt(mediaRequests.syncedAt, runStartedAt)
        )
      )
      .returning({ id: mediaRequests.id });
    pruned = deleted.length;
  }

  return { processed: records.length, pruned };
}

// `excluded.<col>` reference for onConflictDoUpdate - drizzle needs a raw sql
// fragment per column (same pattern as services/librarySync.ts upsertItems).
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

async function runPhase(
  fetcher: () => Promise<{ records: OmbiSyncRecord[]; skipped: number }>,
  mediaType: 'movie' | 'tv',
  resolver: RequesterResolver,
  runStartedAt: Date,
  ombi: OmbiService
): Promise<PhaseResult> {
  try {
    const { records, skipped } = await fetcher();
    // Prune only when the fetch succeeded AND zero records failed validation
    // (ADR 0004 - a partial fetch must never delete real rows).
    const allowPrune = skipped === 0;
    const { processed, pruned } = await upsertPhase(
      mediaType,
      records,
      resolver,
      runStartedAt,
      allowPrune
    );
    return { ok: true, processed, skipped, pruned, error: null };
  } catch (error) {
    // Redacted (SEERR-04 sibling fix) - same reasoning as jobs/seerrSyncQueue.ts:
    // this message is persisted to ombiSyncStatus.lastError and surfaced by
    // GET /ombi/status, so the redaction invariant must hold here too.
    const message = ombi.redact(error instanceof Error ? error.message : 'Unknown error');
    console.warn(`[OmbiSync] ${mediaType} phase failed: ${message}`);
    return { ok: false, processed: 0, skipped: 0, pruned: 0, error: message };
  }
}

// ============================================================================
// Core sync logic - exported standalone so it's directly unit-testable
// without spinning up BullMQ (mirrors jobs/plexTokenRefresh.ts).
// ============================================================================

export interface OmbiSyncRunResult {
  configured: boolean;
  moviePhase: PhaseResult;
  tvPhase: PhaseResult;
}

export async function runOmbiSync(
  triggeredBy: 'manual' | 'scheduled',
  onProgress?: (event: OmbiSyncProgressEvent) => void,
  jobId = `ombi-${triggeredBy}-${Date.now()}`
): Promise<OmbiSyncRunResult> {
  const config = await getOmbiSettings();
  if (!config.ombiUrl || !config.ombiApiKey) {
    // Complete no-op: no network, no DB writes, no log output.
    return { configured: false, moviePhase: emptyPhase(), tvPhase: emptyPhase() };
  }

  const runStartedAt = new Date();
  const previousStatus = await getSetting('ombiSyncStatus');

  let ombi: OmbiService;
  try {
    ombi = new OmbiService(config.ombiUrl, config.ombiApiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid Ombi configuration';
    console.warn(`[OmbiSync] Aborting run: ${message}`);
    await persistStatus(previousStatus, runStartedAt, message, 0, false, false);
    onProgress?.({ jobId, phase: 'error', progress: null, error: message });
    return { configured: true, moviePhase: emptyPhase(message), tvPhase: emptyPhase(message) };
  }

  const resolver = await buildRequesterResolver();

  onProgress?.({ jobId, phase: 'movies', progress: null });
  const moviePhase = await runPhase(
    () => ombi.getMovieRequests(),
    'movie',
    resolver,
    runStartedAt,
    ombi
  );

  onProgress?.({ jobId, phase: 'tv', progress: null });
  const tvPhase = await runPhase(() => ombi.getTvRequests(), 'tv', resolver, runStartedAt, ombi);

  onProgress?.({ jobId, phase: 'resolve', progress: null });

  const combinedError = moviePhase.error ?? tvPhase.error ?? null;
  const skippedValidation = moviePhase.skipped + tvPhase.skipped;
  await persistStatus(
    previousStatus,
    runStartedAt,
    combinedError,
    skippedValidation,
    moviePhase.ok,
    tvPhase.ok
  );

  if (redisClient) {
    await invalidateOmbiCaches(redisClient);
  }

  onProgress?.({
    jobId,
    phase: combinedError ? 'error' : 'done',
    progress: 100,
    ...(combinedError && { error: combinedError }),
  });

  console.log(
    `[OmbiSync] Run complete (${triggeredBy}): movies ${moviePhase.processed} processed/${moviePhase.pruned} pruned, ` +
      `tv ${tvPhase.processed} processed/${tvPhase.pruned} pruned, ${skippedValidation} skipped`
  );

  return { configured: true, moviePhase, tvPhase };
}

async function persistStatus(
  previous: OmbiSyncStatusInternal | null,
  runStartedAt: Date,
  lastError: string | null,
  skippedValidation: number,
  moviePhaseOk: boolean,
  tvPhaseOk: boolean
): Promise<void> {
  const succeeded = lastError === null;
  const status: OmbiSyncStatusInternal = {
    lastRunAt: runStartedAt.toISOString(),
    lastSuccessAt: succeeded ? runStartedAt.toISOString() : (previous?.lastSuccessAt ?? null),
    lastError,
    skippedValidation,
    moviePhaseOk,
    tvPhaseOk,
  };
  await setSetting('ombiSyncStatus', status);
}

// ============================================================================
// BullMQ plumbing
// ============================================================================

export function initOmbiSyncQueue(redisUrl: string): void {
  if (ombiSyncQueue) {
    console.log('[OmbiSync] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  redisClient = new Redis(redisUrl);
  const bullPrefix = `${getRedisPrefix()}bull`;

  ombiSyncQueue = new Queue<OmbiSyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 20, age: 30 * 24 * 60 * 60 },
    },
  });
  ombiSyncQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[OmbiSync] Queue error:', err);
  });

  console.log('[OmbiSync] Queue initialized');
}

export function startOmbiSyncWorker(): void {
  if (!connectionOptions) {
    throw new Error('Ombi sync queue not initialized. Call initOmbiSyncQueue first.');
  }
  if (ombiSyncWorker) {
    console.log('[OmbiSync] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  ombiSyncWorker = new Worker<OmbiSyncJobData>(
    QUEUE_NAME,
    async (job: Job<OmbiSyncJobData>) => {
      const onProgress = (event: OmbiSyncProgressEvent) => {
        if (typeof event.progress === 'number') void job.updateProgress(event.progress);
        const pubSubService = getPubSubService();
        if (pubSubService) void pubSubService.publish(WS_EVENTS.OMBI_SYNC_PROGRESS, event);
      };

      return runOmbiSync(
        job.data.triggeredBy,
        onProgress,
        job.id ?? `ombi-${job.data.triggeredBy}`
      );
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000, // 10 min - well above the "seconds" expected duration (design §5)
    }
  );

  ombiSyncWorker.on('failed', (job, error) => {
    console.error(`[OmbiSync] Job ${job?.id} failed:`, error);
  });
  ombiSyncWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[OmbiSync] Worker error:', error);
  });

  console.log('[OmbiSync] Worker started');
}

/**
 * Registers the 6-hourly repeatable job. Always registered regardless of
 * configuration state (cheap - BullMQ just tracks a cron entry; no work runs
 * until it fires), so that configuring Ombi later takes effect without a
 * restart - each firing re-reads settings via runOmbiSync() and no-ops
 * silently while unconfigured (jobs/telegramCommandListener.ts pattern).
 */
export async function scheduleOmbiSync(): Promise<void> {
  if (!ombiSyncQueue) {
    throw new Error('Ombi sync queue not initialized');
  }

  const schedulers = await ombiSyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await ombiSyncQueue.removeJobScheduler(scheduler.key);
  }

  await ombiSyncQueue.add(
    'scheduled-sync',
    { triggeredBy: 'scheduled' },
    {
      repeat: { pattern: '0 */6 * * *', tz: 'UTC' },
      jobId: SCHEDULER_JOB_ID,
    }
  );

  console.log('[OmbiSync] Scheduled sync every 6 hours');
}

/** Manual trigger (POST /ombi/sync). Throws on unconfigured or already-running
 * (routes/ombi.ts maps these to 400/409 respectively). */
export async function enqueueOmbiSync(userId?: string): Promise<string> {
  if (!ombiSyncQueue) {
    throw new Error('Ombi sync queue not initialized');
  }

  const config = await getOmbiSettings();
  if (!config.ombiUrl || !config.ombiApiKey) {
    throw new Error('Ombi is not configured');
  }

  const activeJobs = await ombiSyncQueue.getJobs(['active', 'waiting']);
  if (activeJobs.length > 0) {
    throw new Error('An Ombi sync is already in progress');
  }

  const job = await ombiSyncQueue.add(
    'manual-sync',
    { triggeredBy: 'manual', userId },
    { jobId: `manual-ombi-sync-${Date.now()}` }
  );

  console.log(`[OmbiSync] Enqueued manual sync (job ${job.id})`);
  return job.id ?? `manual-ombi-sync-${Date.now()}`;
}

export async function isOmbiSyncRunning(): Promise<boolean> {
  if (!ombiSyncQueue) return false;
  const activeJobs = await ombiSyncQueue.getJobs(['active']);
  return activeJobs.length > 0;
}

/** For GET /tasks/running (routes/tasks.ts). */
export async function getAllActiveOmbiSyncs(): Promise<
  Array<{
    jobId: string;
    triggeredBy: 'manual' | 'scheduled';
    state: string;
    progress: number | null;
    createdAt: number;
  }>
> {
  if (!ombiSyncQueue) return [];

  const jobs = await ombiSyncQueue.getJobs(['active', 'waiting']);
  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      const progress = job.progress;
      return {
        jobId: job.id ?? 'unknown',
        triggeredBy: job.data.triggeredBy,
        state,
        progress: typeof progress === 'number' ? progress : null,
        createdAt: job.timestamp ?? Date.now(),
      };
    })
  );
}

export async function shutdownOmbiSyncQueue(): Promise<void> {
  console.log('[OmbiSync] Shutting down queue...');

  if (ombiSyncWorker) {
    await ombiSyncWorker.close();
    ombiSyncWorker = null;
  }
  if (ombiSyncQueue) {
    await ombiSyncQueue.close();
    ombiSyncQueue = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  console.log('[OmbiSync] Queue shutdown complete');
}
