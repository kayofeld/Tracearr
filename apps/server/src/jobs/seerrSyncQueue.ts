/**
 * Seerr Sync Queue - BullMQ-based full-mirror resync of Seerr media requests
 *
 * Single-phase full fetch + upsert + prune every run (ADR 0004, adapted -
 * design §6): one paginated Seerr endpoint serves movies+tv, versus Ombi's
 * two independent unpaged endpoints, so there is one transaction, not two
 * independent phases.
 *
 * Requester -> Tracearr user resolution (ADR 0002 pipeline shape, ADR 0008
 * Seerr specialization): manual override -> persisted external id
 * (jellyfinUserId/plexId against server_users) -> case-insensitive username
 * -> unattributed, recomputed every run. Because the external id is
 * persisted (unlike Ombi's transient providerUserId), a mapping change
 * re-resolves immediately through the FULL pipeline, including the external-
 * id tier (see resolveOneRequester equivalent, called from routes/seerr.ts).
 *
 * Unconfigured = complete no-op: the repeatable scheduler is always
 * registered (so configure/disconnect takes effect without a restart -
 * settings are read fresh on every firing, jobs/telegramCommandListener.ts
 * pattern), but a firing with no seerrUrl/seerrApiKey returns immediately with
 * zero DB writes, zero network calls, and zero log output.
 *
 * Model/precedent: jobs/ombiSyncQueue.ts (queue/worker shape, cache
 * invalidation pattern, pure-business-logic-function split for direct unit
 * testing - jobs/plexTokenRefresh.ts).
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, lt, sql } from 'drizzle-orm';
import { getRedisPrefix, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import type { SeerrSyncProgressEvent } from '@tracearr/shared';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { mediaRequests, mediaRequestUserMappings, serverUsers, users } from '../db/schema.js';
import { getPubSubService } from '../services/cache.js';
import { getSeerrSettings, getSetting, setSetting } from '../services/settings.js';
import type { SeerrSyncStatusInternal } from '../services/settings.js';
import {
  SeerrService,
  type SeerrRawRequesterInfo,
  type SeerrSyncRecord,
} from '../services/seerr.js';

const QUEUE_NAME = 'seerr-sync';
const SCHEDULER_JOB_ID = 'seerr-scheduled-sync';

export interface SeerrSyncJobData {
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // audit trail for manual syncs
}

let connectionOptions: ConnectionOptions | null = null;
let seerrSyncQueue: Queue<SeerrSyncJobData> | null = null;
let seerrSyncWorker: Worker<SeerrSyncJobData> | null = null;
let redisClient: Redis | null = null;

// ============================================================================
// Cache invalidation (design §5 step 6, §6 step 8, contract §8) - exported so
// routes/seerr.ts can call it directly after a mapping change or a purge,
// without waiting for a sync. Reuses the SAME cache keys as Ombi
// (REDIS_KEYS.OMBI_REQUESTER_STATS is the merged stats cache across sources -
// legacy name kept deliberately, contract §8) since both connectors feed the
// same cross-source stats/attribution surfaces (design §9).
// ============================================================================

export async function invalidateSeerrCaches(redis: Redis): Promise<void> {
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
    console.log(`[SeerrSync] Invalidated ${totalDeleted} cache keys`);
  }
}

// ============================================================================
// Requester resolution (ADR 0008)
// ============================================================================

export interface SeerrRequesterResolution {
  userId: string | null;
  matchMethod: 'manual' | 'provider' | 'username' | null;
}

export interface SeerrRequesterResolver {
  resolve(info: SeerrRawRequesterInfo): SeerrRequesterResolution;
}

/**
 * Builds the resolution maps once per sync run (three cheap queries at this
 * volume - dozens of users/server_users, not per-request lookups).
 *
 * Unlike Ombi's buildRequesterResolver, the external-id tier here is checked
 * unconditionally when `externalUserId` is present - it is PERSISTED on the
 * request row (media_requests.source_external_user_id), so the live
 * single-requester re-resolution path (routes/seerr.ts mapping PUT/DELETE)
 * can run this full tier even without a fresh Seerr payload (ADR 0008,
 * contrasted with Ombi's transient providerUserId which forces its live
 * re-resolution to skip tier 2).
 */
export async function buildSeerrRequesterResolver(): Promise<SeerrRequesterResolver> {
  const [mappingRows, serverUserRows, userRows] = await Promise.all([
    db
      .select({
        sourceUserId: mediaRequestUserMappings.sourceUserId,
        userId: mediaRequestUserMappings.userId,
      })
      .from(mediaRequestUserMappings)
      .where(eq(mediaRequestUserMappings.source, 'seerr')),
    db
      .select({
        externalId: serverUsers.externalId,
        plexAccountId: serverUsers.plexAccountId,
        userId: serverUsers.userId,
      })
      .from(serverUsers),
    db.select({ id: users.id, username: users.username }).from(users),
  ]);

  const manualMap = new Map<string, string | null>(
    mappingRows.map((r) => [r.sourceUserId, r.userId])
  );

  // Union of external_id and plex_account_id keyed by the SAME value -
  // source_external_user_id stores whichever Seerr sent (jellyfinUserId
  // preferred, else plexId), so at resolution time we don't need to know
  // which field it originated from (design §8.2).
  const externalIdMap = new Map<string, Set<string>>();
  for (const row of serverUserRows) {
    if (row.externalId) {
      const set = externalIdMap.get(row.externalId) ?? new Set<string>();
      set.add(row.userId);
      externalIdMap.set(row.externalId, set);
    }
    if (row.plexAccountId) {
      const set = externalIdMap.get(row.plexAccountId) ?? new Set<string>();
      set.add(row.userId);
      externalIdMap.set(row.plexAccountId, set);
    }
  }

  const usernameMap = new Map<string, string[]>();
  for (const row of userRows) {
    const key = row.username.toLowerCase();
    const arr = usernameMap.get(key) ?? [];
    arr.push(row.id);
    usernameMap.set(key, arr);
  }

  return {
    resolve({ seerrUserId, seerrUsername, externalUserId }): SeerrRequesterResolution {
      // Tier 1: manual override. userId===null on the mapping row means the
      // owner explicitly forced this requester to stay unattributed.
      if (manualMap.has(seerrUserId)) {
        return { userId: manualMap.get(seerrUserId) ?? null, matchMethod: 'manual' };
      }

      // Tier 2: persisted external id (jellyfinUserId/plexId) - PRIMARY tier
      // for Seerr (ADR 0008), measured 16/16 on the reference instance.
      // Ambiguous (>1 distinct user_id candidate) refuses to guess and falls
      // through, same discipline as the username tier below.
      if (externalUserId) {
        const candidates = externalIdMap.get(externalUserId);
        if (candidates?.size === 1) {
          const [uid] = candidates;
          if (uid) return { userId: uid, matchMethod: 'provider' };
        }
      }

      // Tier 3: case-insensitive username. Ambiguous (>1 candidate) refuses
      // to guess and falls through to unattributed.
      const candidates = usernameMap.get(seerrUsername.toLowerCase());
      const soleCandidate = candidates?.length === 1 ? candidates[0] : undefined;
      if (soleCandidate) {
        return { userId: soleCandidate, matchMethod: 'username' };
      }

      return { userId: null, matchMethod: null };
    },
  };
}

// ============================================================================
// Upsert + prune (ADR 0004, single phase per design §6)
// ============================================================================

interface PhaseResult {
  ok: boolean;
  processed: number;
  skipped: number;
  pruned: number;
  error: string | null;
}

function emptyPhase(error: string | null = null): PhaseResult {
  return { ok: error === null, processed: 0, skipped: 0, pruned: 0, error };
}

async function upsertAndPrune(
  records: SeerrSyncRecord[],
  resolver: SeerrRequesterResolver,
  runStartedAt: Date,
  allowPrune: boolean
): Promise<{ processed: number; pruned: number }> {
  let pruned = 0;

  if (records.length > 0) {
    const rows = records.map((r) => {
      const resolution = resolver.resolve(r.requester);
      return {
        source: 'seerr' as const,
        sourceRequestId: r.seerrRequestId,
        sourceParentRequestId: null,
        mediaType: r.mediaType,
        title: r.title, // always null v1 - ADR 0007
        releaseYear: r.releaseYear,
        imdbId: r.imdbId,
        tmdbId: r.tmdbId,
        tvdbId: r.tvdbId,
        seasons: r.seasons,
        is4k: r.is4k,
        status: r.status,
        requestedAt: r.requestedAt,
        availableAt: r.availableAt,
        sourceUserId: r.requester.seerrUserId,
        sourceUsername: r.requester.seerrUsername,
        sourceAlias: r.requester.seerrAlias,
        sourceExternalUserId: r.requester.externalUserId,
        userId: resolution.userId,
        matchMethod: resolution.matchMethod,
        syncedAt: runStartedAt,
      };
    });

    await db.transaction(async (tx) => {
      await tx
        .insert(mediaRequests)
        .values(rows)
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
            sourceExternalUserId: sqlExcluded('source_external_user_id'),
            userId: sqlExcluded('user_id'),
            matchMethod: sqlExcluded('match_method'),
            syncedAt: sqlExcluded('synced_at'),
            updatedAt: new Date(),
          },
        });

      if (allowPrune) {
        const deleted = await tx
          .delete(mediaRequests)
          .where(and(eq(mediaRequests.source, 'seerr'), lt(mediaRequests.syncedAt, runStartedAt)))
          .returning({ id: mediaRequests.id });
        pruned = deleted.length;
      }
    });
  } else if (allowPrune) {
    // Zero live records this run (e.g. the owner deleted everything in Seerr) -
    // every existing seerr row is now stale and should be pruned too.
    const deleted = await db
      .delete(mediaRequests)
      .where(and(eq(mediaRequests.source, 'seerr'), lt(mediaRequests.syncedAt, runStartedAt)))
      .returning({ id: mediaRequests.id });
    pruned = deleted.length;
  }

  return { processed: records.length, pruned };
}

// `excluded.<col>` reference for onConflictDoUpdate - drizzle needs a raw sql
// fragment per column (same pattern as jobs/ombiSyncQueue.ts).
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

// ============================================================================
// Core sync logic - exported standalone so it's directly unit-testable
// without spinning up BullMQ (mirrors jobs/plexTokenRefresh.ts).
// ============================================================================

export interface SeerrSyncRunResult {
  configured: boolean;
  phase: PhaseResult;
}

export async function runSeerrSync(
  triggeredBy: 'manual' | 'scheduled',
  onProgress?: (event: SeerrSyncProgressEvent) => void,
  jobId = `seerr-${triggeredBy}-${Date.now()}`
): Promise<SeerrSyncRunResult> {
  const config = await getSeerrSettings();
  if (!config.seerrUrl || !config.seerrApiKey) {
    // Complete no-op: no network, no DB writes, no log output.
    return { configured: false, phase: emptyPhase() };
  }

  const runStartedAt = new Date();
  const previousStatus = await getSetting('seerrSyncStatus');

  let seerr: SeerrService;
  try {
    seerr = new SeerrService(config.seerrUrl, config.seerrApiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid Seerr configuration';
    console.warn(`[SeerrSync] Aborting run: ${message}`);
    await persistStatus(previousStatus, runStartedAt, message, 0);
    onProgress?.({ jobId, phase: 'error', progress: null, error: message });
    return { configured: true, phase: emptyPhase(message) };
  }

  onProgress?.({ jobId, phase: 'count', progress: null });
  // Count call is best-effort - only used as a progress denominator /
  // consistency reference (design §6 step 3). A failure here must not abort
  // the run; the fetch phase below is authoritative.
  try {
    await seerr.getRequestCount();
  } catch (error) {
    console.warn(
      `[SeerrSync] Count phase failed (non-fatal): ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }

  onProgress?.({ jobId, phase: 'fetch', progress: null });

  let phase: PhaseResult;
  try {
    const { records, skipped, paginationConsistent } = await seerr.fetchAllRequests();

    onProgress?.({ jobId, phase: 'resolve', progress: null });
    const resolver = await buildSeerrRequesterResolver();

    // Prune only when zero validation failures AND pagination completed
    // cleanly (design §6 step 6) - a partial/inconsistent fetch must never
    // delete real rows. A skipped prune self-heals next run.
    const allowPrune = skipped === 0 && paginationConsistent;
    const { processed, pruned } = await upsertAndPrune(records, resolver, runStartedAt, allowPrune);

    phase = { ok: true, processed, skipped, pruned, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[SeerrSync] Fetch/resolve phase failed: ${message}`);
    phase = { ok: false, processed: 0, skipped: 0, pruned: 0, error: message };
  }

  await persistStatus(previousStatus, runStartedAt, phase.error, phase.skipped);

  if (redisClient) {
    await invalidateSeerrCaches(redisClient);
  }

  onProgress?.({
    jobId,
    phase: phase.error ? 'error' : 'done',
    progress: 100,
    ...(phase.error && { error: phase.error }),
  });

  console.log(
    `[SeerrSync] Run complete (${triggeredBy}): ${phase.processed} processed/${phase.pruned} pruned, ${phase.skipped} skipped`
  );

  return { configured: true, phase };
}

async function persistStatus(
  previous: SeerrSyncStatusInternal | null,
  runStartedAt: Date,
  lastError: string | null,
  skippedValidation: number
): Promise<void> {
  const succeeded = lastError === null;
  const status: SeerrSyncStatusInternal = {
    lastRunAt: runStartedAt.toISOString(),
    lastSuccessAt: succeeded ? runStartedAt.toISOString() : (previous?.lastSuccessAt ?? null),
    lastError,
    skippedValidation,
  };
  await setSetting('seerrSyncStatus', status);
}

// ============================================================================
// BullMQ plumbing
// ============================================================================

export function initSeerrSyncQueue(redisUrl: string): void {
  if (seerrSyncQueue) {
    console.log('[SeerrSync] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  redisClient = new Redis(redisUrl);
  const bullPrefix = `${getRedisPrefix()}bull`;

  seerrSyncQueue = new Queue<SeerrSyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 20, age: 30 * 24 * 60 * 60 },
    },
  });
  seerrSyncQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[SeerrSync] Queue error:', err);
  });

  console.log('[SeerrSync] Queue initialized');
}

export function startSeerrSyncWorker(): void {
  if (!connectionOptions) {
    throw new Error('Seerr sync queue not initialized. Call initSeerrSyncQueue first.');
  }
  if (seerrSyncWorker) {
    console.log('[SeerrSync] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  seerrSyncWorker = new Worker<SeerrSyncJobData>(
    QUEUE_NAME,
    async (job: Job<SeerrSyncJobData>) => {
      const onProgress = (event: SeerrSyncProgressEvent) => {
        if (typeof event.progress === 'number') void job.updateProgress(event.progress);
        const pubSubService = getPubSubService();
        if (pubSubService) void pubSubService.publish(WS_EVENTS.SEERR_SYNC_PROGRESS, event);
      };

      return runSeerrSync(
        job.data.triggeredBy,
        onProgress,
        job.id ?? `seerr-${job.data.triggeredBy}`
      );
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000, // 10 min - well above the "seconds" expected duration (design §6)
    }
  );

  seerrSyncWorker.on('failed', (job, error) => {
    console.error(`[SeerrSync] Job ${job?.id} failed:`, error);
  });
  seerrSyncWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[SeerrSync] Worker error:', error);
  });

  console.log('[SeerrSync] Worker started');
}

/**
 * Registers the 6-hourly repeatable job. Always registered regardless of
 * configuration state (cheap - BullMQ just tracks a cron entry; no work runs
 * until it fires), so that configuring Seerr later takes effect without a
 * restart - each firing re-reads settings via runSeerrSync() and no-ops
 * silently while unconfigured (jobs/telegramCommandListener.ts pattern).
 */
export async function scheduleSeerrSync(): Promise<void> {
  if (!seerrSyncQueue) {
    throw new Error('Seerr sync queue not initialized');
  }

  const schedulers = await seerrSyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await seerrSyncQueue.removeJobScheduler(scheduler.key);
  }

  await seerrSyncQueue.add(
    'scheduled-sync',
    { triggeredBy: 'scheduled' },
    {
      repeat: { pattern: '0 */6 * * *', tz: 'UTC' },
      jobId: SCHEDULER_JOB_ID,
    }
  );

  console.log('[SeerrSync] Scheduled sync every 6 hours');
}

/** Manual trigger (POST /seerr/sync). Throws on unconfigured or already-running
 * (routes/seerr.ts maps these to 400/409 respectively). */
export async function enqueueSeerrSync(userId?: string): Promise<string> {
  if (!seerrSyncQueue) {
    throw new Error('Seerr sync queue not initialized');
  }

  const config = await getSeerrSettings();
  if (!config.seerrUrl || !config.seerrApiKey) {
    throw new Error('Seerr is not configured');
  }

  const activeJobs = await seerrSyncQueue.getJobs(['active', 'waiting']);
  if (activeJobs.length > 0) {
    throw new Error('A Seerr sync is already in progress');
  }

  const job = await seerrSyncQueue.add(
    'manual-sync',
    { triggeredBy: 'manual', userId },
    { jobId: `manual-seerr-sync-${Date.now()}` }
  );

  console.log(`[SeerrSync] Enqueued manual sync (job ${job.id})`);
  return job.id ?? `manual-seerr-sync-${Date.now()}`;
}

export async function isSeerrSyncRunning(): Promise<boolean> {
  if (!seerrSyncQueue) return false;
  const activeJobs = await seerrSyncQueue.getJobs(['active']);
  return activeJobs.length > 0;
}

/** For GET /tasks/running (routes/tasks.ts). */
export async function getAllActiveSeerrSyncs(): Promise<
  Array<{
    jobId: string;
    triggeredBy: 'manual' | 'scheduled';
    state: string;
    progress: number | null;
    createdAt: number;
  }>
> {
  if (!seerrSyncQueue) return [];

  const jobs = await seerrSyncQueue.getJobs(['active', 'waiting']);
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

export async function shutdownSeerrSyncQueue(): Promise<void> {
  console.log('[SeerrSync] Shutting down queue...');

  if (seerrSyncWorker) {
    await seerrSyncWorker.close();
    seerrSyncWorker = null;
  }
  if (seerrSyncQueue) {
    await seerrSyncQueue.close();
    seerrSyncQueue = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  console.log('[SeerrSync] Queue shutdown complete');
}
