/**
 * Played-State Sync Queue - BullMQ-based per-user played-flag mirror sync
 *
 * Design: docs/architecture/emby-played-state-sync.md §6.1/§6.3. Mirrors
 * jobs/librarySyncQueue.ts's queue/worker/schedule/invalidate shape.
 *
 * Two ways a job runs:
 * - Scheduled/boot jobs always carry a concrete serverId (one repeatable job
 *   per capable server, like library sync).
 * - A manual trigger with no serverId ("sync every capable server") is a
 *   single job whose data.serverId is undefined; the worker fans out over
 *   every non-Plex server sequentially within that one job execution, since
 *   the API contract's PlayedStateSyncTriggerResponse carries exactly one
 *   jobId (§7.1/§7.2).
 *
 * Worker concurrency is 1 (not 2, like library sync): a "sync all" job walks
 * every server's played_states rows, so it must not overlap a per-server job
 * touching the same rows.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { isMaintenance } from '../serverState.js';
import { getRedisPrefix, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import type { PlayedStateSyncProgress } from '@tracearr/shared';
import { Redis } from 'ioredis';
import { eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { playedStateSyncService } from '../services/playedStateSync.js';
import { getPubSubService } from '../services/cache.js';

/** Job data. `serverId` undefined means "every capable (non-Plex) server". */
export interface PlayedStateSyncJobData {
  serverId?: string;
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // For audit trail on manual syncs
}

const QUEUE_NAME = 'played-state-sync';

let connectionOptions: ConnectionOptions | null = null;
let playedStateSyncQueue: Queue<PlayedStateSyncJobData> | null = null;
let playedStateSyncWorker: Worker<PlayedStateSyncJobData> | null = null;
let redisClient: Redis | null = null;
/** Per-server guard - keyed by serverId, set while that server is actively syncing. */
const activeSyncs = new Map<string, boolean>();

/**
 * Invalidate library-analytics caches that embed played-state-derived data
 * after a sync completes (design §5.3). Exported (redis passed in, mirrors
 * invalidateLibraryCaches in librarySyncQueue.ts) so the key-pattern list is
 * unit-testable without a live BullMQ worker/Redis connection.
 */
export async function invalidatePlayedStateCaches(redis: Redis, serverId: string): Promise<void> {
  const patterns = [`${REDIS_KEYS.LIBRARY_STALE}*`, `${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`];

  let totalDeleted = 0;
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
  }

  if (totalDeleted > 0) {
    console.log(`[PlayedStateSync] Invalidated ${totalDeleted} cache keys for server ${serverId}`);
  }
}

/** Initialize the played-state sync queue with a Redis connection. */
export function initPlayedStateSyncQueue(redisUrl: string): void {
  if (playedStateSyncQueue) {
    console.log('Played-state sync queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  redisClient = new Redis(redisUrl);
  const bullPrefix = `${getRedisPrefix()}bull`;

  playedStateSyncQueue = new Queue<PlayedStateSyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1 minute initial delay
      },
      removeOnComplete: {
        count: 100,
        age: 7 * 24 * 60 * 60,
      },
      removeOnFail: {
        count: 50,
      },
    },
  });
  playedStateSyncQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[PlayedStateSync] Queue error:', err);
  });

  console.log('Played-state sync queue initialized');
}

/** Get every capable (non-Plex) server id, for the "sync all" fan-out and the schedule. */
async function getCapableServerIds(): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(ne(servers.type, 'plex'));
}

/** Start the played-state sync worker to process queued jobs. */
export function startPlayedStateSyncWorker(): void {
  if (!connectionOptions) {
    throw new Error(
      'Played-state sync queue not initialized. Call initPlayedStateSyncQueue first.'
    );
  }

  if (playedStateSyncWorker) {
    console.log('Played-state sync worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  playedStateSyncWorker = new Worker<PlayedStateSyncJobData>(
    QUEUE_NAME,
    async (job: Job<PlayedStateSyncJobData>) => {
      const { serverId, triggeredBy } = job.data;
      const startTime = Date.now();

      const targetServers: Array<{ id: string; name?: string }> = serverId
        ? [{ id: serverId }]
        : await getCapableServerIds();

      console.log(
        `[PlayedStateSync] Starting job ${job.id} (${triggeredBy}): ${
          serverId ? `server ${serverId}` : `${targetServers.length} capable server(s)`
        }`
      );

      const results: Awaited<ReturnType<typeof playedStateSyncService.syncServer>>[] = [];

      for (const target of targetServers) {
        if (activeSyncs.get(target.id)) {
          console.log(
            `[PlayedStateSync] Skipping server ${target.id} in job ${job.id} - already syncing`
          );
          continue;
        }

        activeSyncs.set(target.id, true);
        try {
          const onProgress = (progress: PlayedStateSyncProgress) => {
            const pubSubService = getPubSubService();
            if (pubSubService) {
              void pubSubService.publish(WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS, progress);
            }
          };

          const result = await playedStateSyncService.syncServer(target.id, onProgress);
          results.push(result);

          if (result.status !== 'unsupported' && redisClient) {
            await invalidatePlayedStateCaches(redisClient, target.id);
          }
        } catch (error) {
          console.error(`[PlayedStateSync] Server ${target.id} failed in job ${job.id}:`, error);
        } finally {
          activeSyncs.delete(target.id);
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[PlayedStateSync] Job ${job.id} completed in ${duration}s:`, {
        servers: results.length,
        itemsUpserted: results.reduce((sum, r) => sum + r.itemsUpserted, 0),
        itemsPruned: results.reduce((sum, r) => sum + r.itemsPruned, 0),
      });

      return { success: true, results };
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
      lockDuration: 60 * 60 * 1000, // 1 hour - a "sync all" fan-out can take a while
      stalledInterval: 30 * 1000,
      maxStalledCount: 2,
    }
  );

  playedStateSyncWorker.on('stalled', (jobId) => {
    console.warn(`[PlayedStateSync] Job ${jobId} stalled - will be retried`);
  });

  playedStateSyncWorker.on('failed', (job, error) => {
    if (!job) return;
    const { serverId } = job.data;
    if (serverId) activeSyncs.delete(serverId);

    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS, {
        serverId: serverId ?? 'unknown',
        serverName: 'Unknown',
        status: 'error',
        totalUsers: 0,
        processedUsers: 0,
        itemsProcessed: 0,
        message: `Sync failed: ${error?.message || 'Unknown error'}`,
        startedAt: new Date().toISOString(),
      } satisfies PlayedStateSyncProgress);
    }

    console.error(`[PlayedStateSync] Job ${job.id} failed:`, error);
  });

  playedStateSyncWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[PlayedStateSync] Worker error:', error);
  });

  console.log('Played-state sync worker started');
}

/**
 * Schedule auto-sync for every capable (non-Plex) server, every 12 hours,
 * staggered at minute (40 + i*4) % 60 - offset from library sync's
 * (10 + i*4) % 60 so a small fleet's syncs don't fire together (§6.3).
 */
export async function schedulePlayedStateSync(): Promise<void> {
  if (!playedStateSyncQueue) {
    throw new Error('Played-state sync queue not initialized');
  }

  const capableServers = await getCapableServerIds();

  if (capableServers.length === 0) {
    console.log('[PlayedStateSync] No capable servers found - skipping auto-sync scheduling');
    return;
  }

  const schedulers = await playedStateSyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await playedStateSyncQueue.removeJobScheduler(scheduler.key);
  }

  for (let i = 0; i < capableServers.length; i++) {
    const server = capableServers[i]!;
    const minuteOffset = (40 + i * 4) % 60;

    await playedStateSyncQueue.add(
      `auto-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        repeat: {
          pattern: `${minuteOffset} */12 * * *`,
          tz: 'UTC',
        },
        jobId: `scheduled-${server.id}`,
      }
    );
  }

  console.log(
    `[PlayedStateSync] Scheduled auto-sync for ${capableServers.length} capable server(s) every 12 hours (staggered)`
  );

  // Boot sync, staggered - skip servers with a pending job already queued.
  const pendingJobs = await playedStateSyncQueue.getJobs(['delayed', 'waiting']);
  const pendingServerIds = new Set(pendingJobs.map((j) => j.data.serverId));

  for (let i = 0; i < capableServers.length; i++) {
    const server = capableServers[i]!;

    if (pendingServerIds.has(server.id)) {
      console.log(`[PlayedStateSync] Skipping boot sync for ${server.name} - job already pending`);
      continue;
    }

    await playedStateSyncQueue.add(
      `boot-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        delay: (i + 1) * 10000,
        jobId: `boot-sync-${server.id}-${Date.now()}`,
      }
    );
  }

  console.log(`[PlayedStateSync] Queued boot sync for ${capableServers.length} capable server(s)`);
}

/**
 * Manually trigger a played-state sync.
 *
 * @param serverId - Sync only this server. Omit to sync every capable server
 *   in one job (§7.4).
 * @param userId - Audit trail for manual syncs.
 * @throws Error containing "already in progress" if a conflicting job is active.
 */
export async function enqueuePlayedStateSync(serverId?: string, userId?: string): Promise<string> {
  if (!playedStateSyncQueue) {
    throw new Error('Played-state sync queue not initialized');
  }

  const activeJobs = await playedStateSyncQueue.getJobs(['active']);
  const conflicting = activeJobs.some((job) => {
    const jobServerId = job.data.serverId;
    if (serverId) {
      // A per-server request conflicts with a job already running for that
      // exact server, or with an in-flight "sync all" job (which will reach
      // this server too).
      return jobServerId === serverId || jobServerId === undefined;
    }
    // A "sync all" request conflicts with anything already active.
    return true;
  });

  if (conflicting) {
    throw new Error('A played-state sync is already in progress');
  }

  const job = await playedStateSyncQueue.add(
    serverId ? `manual-sync-${serverId}` : 'manual-sync-all',
    {
      serverId,
      triggeredBy: 'manual',
      userId,
    },
    {
      jobId: `manual-${serverId ?? 'all'}-${Date.now()}`,
    }
  );

  console.log(
    `[PlayedStateSync] Enqueued manual sync (job ${job.id}) for ${serverId ? `server ${serverId}` : 'every capable server'}`
  );
  return job.id ?? `manual-${serverId ?? 'all'}-${Date.now()}`;
}

/**
 * Get all active/pending played-state sync jobs - for the running-tasks API
 * (routes/tasks.ts), mirroring getAllActiveLibrarySyncs.
 */
export async function getAllActivePlayedStateSyncs(): Promise<
  Array<{
    jobId: string;
    serverId: string | undefined;
    triggeredBy: 'manual' | 'scheduled';
    state: string;
    progress: number | null;
    createdAt: number;
  }>
> {
  if (!playedStateSyncQueue) {
    return [];
  }

  const jobs = await playedStateSyncQueue.getJobs(['active', 'waiting', 'delayed']);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      const progress = job.progress;
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        triggeredBy: job.data.triggeredBy,
        state,
        progress: typeof progress === 'number' ? progress : null,
        createdAt: job.timestamp ?? Date.now(),
      };
    })
  );
}

/** Gracefully shut down the played-state sync queue. */
export async function shutdownPlayedStateSyncQueue(): Promise<void> {
  console.log('Shutting down played-state sync queue...');

  if (playedStateSyncWorker) {
    await playedStateSyncWorker.close();
    playedStateSyncWorker = null;
  }

  if (playedStateSyncQueue) {
    await playedStateSyncQueue.close();
    playedStateSyncQueue = null;
  }

  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  console.log('Played-state sync queue shutdown complete');
}

/** Fetch existence + type for a server, used by the route to validate a manual-trigger target. */
export async function getServerForPlayedStateSync(
  serverId: string
): Promise<{ id: string; type: string } | null> {
  const [server] = await db
    .select({ id: servers.id, type: servers.type })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  return server ?? null;
}
