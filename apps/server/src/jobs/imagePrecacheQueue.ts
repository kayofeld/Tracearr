/**
 * Image Precache Queue - warms the poster cache for a server after its
 * library sync completes, so the first browse of a freshly synced library
 * doesn't pay the cold-fetch cost for every poster.
 *
 * Walks library_items in cursor-ordered batches of 50, re-enqueueing itself
 * with the next cursor until the server is fully warmed. Pauses (delayed
 * re-enqueue) while a sync for the same server is active, since the sync
 * itself may still be writing thumb_path/dominant_color for these rows.
 *
 * A pass can optionally be scoped to `sinceUpdatedAt`: only rows whose
 * library_items.updated_at moved on/after that timestamp are candidates.
 * The caller (librarySyncQueue.ts) decides when to use a watermark versus a
 * full walk, and propagates the same value through every cursor-continuation
 * and delayed re-enqueue so a single pass stays consistently scoped.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { and, asc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { POSTER_IMAGE_SIZE } from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { libraryItems, servers } from '../db/schema.js';
import { proxyImage, posterCacheEntryExists } from '../services/imageProxy.js';
import {
  takeRefusedWrites,
  writeDiskLimited,
  clearDiskLimited,
  readDiskLimited,
} from '../services/imageCacheGuard.js';
import { sweepImageCache } from '../services/imageCacheSweep.js';
import { getRedis } from '../lib/redisShared.js';
import { getSetting } from '../services/settings.js';
import { getLibrarySyncStatus } from './librarySyncQueue.js';
import { reconcileImagePrecacheOnBoot } from './imagePrecacheBoot.js';

export interface ImagePrecacheJobData {
  serverId: string;
  cursor: string | null;
  /** Only warm rows whose library_items.updated_at is on/after this ISO
   *  timestamp. Omitted (or null) means a full pass over every active item
   *  with a thumb_path - the periodic backstop that heals disk cache
   *  eviction or anything a watermark pass could miss. */
  sinceUpdatedAt?: string | null;
  /** Pass-level progress for the running-tasks UI, threaded through the
   *  cursor chain. Seeded by the first batch (which counts eligible rows)
   *  and absent on externally-enqueued pass starts. */
  totalItems?: number;
  processedItems?: number;
  /** ISO start of the whole pass, not of the current chained job. */
  passStartedAt?: string;
  /** Writes the disk guard refused during this pass so far; the final batch turns it into the flag. */
  refusedWrites?: number;
}

const QUEUE_NAME = 'image-precache';
const BATCH_SIZE = 50;
// Self-limits to at most 2 of the global 6 fetch-semaphore slots (imageProxy.ts)
// so a precache pass never starves live poster requests from real browsing.
const MAX_CONCURRENT_WARMS = 2;
const SYNC_ACTIVE_RETRY_DELAY_MS = 60 * 1000;

let connectionOptions: ConnectionOptions | null = null;
let imagePrecacheQueue: Queue<ImagePrecacheJobData> | null = null;
let imagePrecacheWorker: Worker<ImagePrecacheJobData> | null = null;

/**
 * Initialize the image precache queue with a Redis connection.
 */
export function initImagePrecacheQueue(redisUrl: string): void {
  if (imagePrecacheQueue) {
    console.log('[ImagePrecache] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

  imagePrecacheQueue = new Queue<ImagePrecacheJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60, // 24h
      },
      removeOnFail: {
        count: 50,
      },
    },
  });
  imagePrecacheQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Queue error:', err);
  });

  console.log('[ImagePrecache] Queue initialized');
}

/**
 * Start the image precache worker to process queued jobs.
 */
export async function startImagePrecacheWorker(): Promise<void> {
  if (!connectionOptions) {
    throw new Error('Image precache queue not initialized. Call initImagePrecacheQueue first.');
  }

  if (imagePrecacheWorker) {
    console.log('[ImagePrecache] Worker already running');
    return;
  }

  // One-time reconciliation for the 2.2 poster cache change: empties any
  // backlog of interleaved passes, queues one fresh pass per server, and
  // sweeps the old copies. A failure here must not cost the process its worker.
  await reconcileImagePrecacheOnBoot({
    queue: imagePrecacheQueue!,
    redis: getRedis(),
    listServerIds: async () => (await db.select({ id: servers.id }).from(servers)).map((r) => r.id),
    enqueuePass: (serverId) => enqueueImagePrecache(serverId),
    sweep: () => sweepImageCache(),
  }).catch((err: unknown) => {
    console.error('[ImagePrecache] boot reconciliation failed:', err);
  });

  // Older builds queued a pass per sync, so an install can boot with a backlog.
  // A sweep that can't reach Redis must not cost the process its worker.
  await dropDuplicatePasses().catch((err: unknown) => {
    console.error('[ImagePrecache] Backlog sweep failed:', err);
  });

  const bullPrefix = getBullPrefix();

  imagePrecacheWorker = new Worker<ImagePrecacheJobData>(
    QUEUE_NAME,
    async (job: Job<ImagePrecacheJobData>) => processImagePrecacheJob(job),
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  imagePrecacheWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Worker error:', error);
  });

  console.log('[ImagePrecache] Worker started');
}

/** Everything the queue holds for one server (or for every server), split by
 *  whether the worker has already picked it up. */
async function queuedPassJobs(serverId?: string): Promise<{
  active: Array<Job<ImagePrecacheJobData>>;
  pending: Array<Job<ImagePrecacheJobData>>;
}> {
  if (!imagePrecacheQueue) return { active: [], pending: [] };

  const [active, pending] = await Promise.all([
    imagePrecacheQueue.getJobs(['active']),
    imagePrecacheQueue.getJobs(['waiting', 'delayed']),
  ]);
  const forServer = (jobs: Array<Job<ImagePrecacheJobData>>) =>
    serverId === undefined ? jobs : jobs.filter((job) => job.data.serverId === serverId);

  return { active: forServer(active), pending: forServer(pending) };
}

/** A pass start is what enqueueImagePrecache adds: no cursor and no
 *  passStartedAt. Both conjuncts matter - passStartedAt only ships from 2.1.0,
 *  so a 2.0.x backlog's continuations are told apart by their cursor. */
function isPassStart(job: Job<ImagePrecacheJobData>): boolean {
  return job.data.passStartedAt === undefined && job.data.cursor === null;
}

/**
 * Remove queued pass starts beyond the one that should remain for a server:
 * the OLDEST survives (its sinceUpdatedAt is the earliest, so it covers the
 * most), and a server whose pass is already in flight keeps none. Other
 * servers and the continuations of a running pass are never touched.
 */
async function dropDuplicatePasses(serverId?: string): Promise<string[]> {
  const { active, pending } = await queuedPassJobs(serverId);

  const inFlight = new Set(
    [...active, ...pending.filter((job) => !isPassStart(job))].map((job) => job.data.serverId)
  );
  const startsByServer = new Map<string, Array<Job<ImagePrecacheJobData>>>();
  for (const job of pending) {
    if (!isPassStart(job)) continue;
    const starts = startsByServer.get(job.data.serverId) ?? [];
    starts.push(job);
    startsByServer.set(job.data.serverId, starts);
  }

  const dropped: string[] = [];
  for (const [id, starts] of startsByServer) {
    starts.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const doomed = inFlight.has(id) ? starts : starts.slice(1);
    let removedHere = 0;
    for (const job of doomed) {
      // A start that raced to active refuses removal - it is the pass now, not a duplicate.
      const gone = await job
        .remove()
        .then(() => true)
        .catch(() => false);
      if (!gone) continue;
      removedHere++;
      if (job.id !== undefined) dropped.push(job.id);
    }
    if (removedHere > 0) {
      console.log(`[ImagePrecache] dropped ${removedHere} duplicate passes for ${id}`);
    }
  }

  return dropped;
}

/**
 * Enqueue an image precache pass for a server. No-ops when the setting is
 * disabled, the queue isn't initialized, or a pass for the server is already
 * queued or running, so callers don't need to check any of that themselves.
 * A returned job id is the caller's proof that a pass really queued.
 */
export async function enqueueImagePrecache(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<string | undefined> {
  if (!imagePrecacheQueue) return undefined;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) return undefined;

  const { active, pending } = await queuedPassJobs(serverId);
  if (active.length > 0 || pending.length > 0) return undefined;

  const job = await imagePrecacheQueue.add(
    'precache',
    sinceUpdatedAt ? { serverId, cursor: null, sinceUpdatedAt } : { serverId, cursor: null },
    { jobId: `precache-${serverId}-start-${Date.now()}` }
  );

  // Two syncs can clear the check above in the same tick. The sweep leaves one
  // start either way; which of them reports it depends on who sweeps first, and
  // both resolved the same watermark, so the survivor covers either one's window.
  const dropped = await dropDuplicatePasses(serverId);
  if (job.id !== undefined && dropped.includes(job.id)) return undefined;

  return job.id;
}

/** Chain continuation: carries the full job data (including pass progress)
 *  forward, with an optional delay. Fresh jobId every call - Date.now()
 *  advances, so a same-tick re-add of the active job's own id can't collide. */
async function enqueueChained(data: ImagePrecacheJobData, delayMs?: number) {
  if (!imagePrecacheQueue) return;

  const job = await imagePrecacheQueue.add('precache', data, {
    jobId: `precache-${data.serverId}-${data.cursor ?? 'start'}-${Date.now()}`,
    ...(delayMs !== undefined ? { delay: delayMs } : {}),
  });
  return job.id;
}

/** Count the rows a pass will walk - same predicate as fetchBatch, minus the
 *  cursor. Runs once per pass (first batch) to seed the progress total. */
async function countEligibleItems(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    );
  return row?.n ?? 0;
}

interface PrecacheBatchRow {
  id: string;
  thumbPath: string;
}

/**
 * Raw candidate rows for a server, active and with a thumb path, cursor-paged
 * by id. Does NOT filter by dominant_color or grid-cache existence - a row
 * with dominant_color already set can still be missing its 240/360 grid
 * entries (dominant_color is written by the first proxyImage call at ANY
 * width, including live browsing traffic at other sizes). Termination in
 * processImagePrecacheJob depends on this returning the raw SQL row count
 * unfiltered, so no JS-side filtering happens here.
 */
async function fetchBatch(
  serverId: string,
  cursor: string | null,
  sinceUpdatedAt?: string | null
): Promise<PrecacheBatchRow[]> {
  const rows = await db
    .select({ id: libraryItems.id, thumbPath: libraryItems.thumbPath })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        cursor ? gt(libraryItems.id, cursor) : undefined,
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    )
    .orderBy(asc(libraryItems.id))
    .limit(BATCH_SIZE);

  return rows.map((row) => ({ id: row.id, thumbPath: row.thumbPath! }));
}

/** One proxyImage call for one item, at the poster's one cache size. Each
 *  task is a single fetch-semaphore acquisition at most, so bounding
 *  concurrent tasks to MAX_CONCURRENT_WARMS bounds concurrent semaphore
 *  slots the same way. */
async function runWarmTask(serverId: string, thumbPath: string): Promise<void> {
  await proxyImage({ serverId, imagePath: thumbPath, ...POSTER_IMAGE_SIZE, fallback: 'poster' });
}

/**
 * Process one batch: warm at most MAX_CONCURRENT_WARMS items at a time, one
 * proxyImage call each (posters have exactly one cache size now), so bounding
 * concurrent items bounds concurrent fetch-semaphore acquisitions the same
 * way. Re-enqueues for the next cursor when the raw batch came back full
 * (more items may remain beyond it).
 *
 * Fail-open: precache is a best-effort background warm, so one item's warm
 * failing is logged and skipped rather than failing the batch or the job.
 */
export async function processImagePrecacheJob(
  job: Job<ImagePrecacheJobData>
): Promise<{ skipped: true; reason: string } | { done: true } | { processed: number }> {
  const { serverId, cursor, sinceUpdatedAt } = job.data;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const passStartedAt =
    job.data.passStartedAt ?? new Date(job.timestamp ?? Date.now()).toISOString();

  const syncStatus = await getLibrarySyncStatus(serverId);
  if (syncStatus?.isActive) {
    // Raw passthrough - the sync-active backoff must stay DB-free, so the
    // progress seed (which counts rows) waits for an actual processing run.
    await enqueueChained(
      {
        serverId,
        cursor,
        sinceUpdatedAt,
        totalItems: job.data.totalItems,
        processedItems: job.data.processedItems,
        passStartedAt,
        refusedWrites: job.data.refusedWrites,
      },
      SYNC_ACTIVE_RETRY_DELAY_MS
    );
    return { skipped: true, reason: 'sync active' };
  }

  // Seed pass progress on the first processing batch; continuations carry it.
  const processedItems = job.data.processedItems ?? 0;
  const totalItems = job.data.totalItems ?? (await countEligibleItems(serverId, sinceUpdatedAt));

  const batch = await fetchBatch(serverId, cursor, sinceUpdatedAt);
  if (batch.length === 0) {
    await recordPassOutcome(job.data.refusedWrites ?? 0);
    return { done: true };
  }

  const missing = (
    await Promise.all(
      batch.map(async (item) =>
        (await posterCacheEntryExists(serverId, item.thumbPath)) ? null : item
      )
    )
  ).filter((item): item is PrecacheBatchRow => item !== null);

  let nextIndex = 0;
  async function warmPoolWorker(): Promise<void> {
    while (nextIndex < missing.length) {
      const item = missing[nextIndex++]!;
      // Fail-open: a single warm failing must not fail the batch or the job.
      try {
        await runWarmTask(serverId, item.thumbPath);
      } catch (err) {
        console.error(`[ImagePrecache] Failed to warm item ${item.id}:`, err);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_WARMS, missing.length) }, () => warmPoolWorker())
  );

  const refusedWrites = (job.data.refusedWrites ?? 0) + takeRefusedWrites();
  if (batch.length === BATCH_SIZE) {
    const nextCursor = batch[batch.length - 1]!.id;
    await enqueueChained({
      serverId,
      cursor: nextCursor,
      sinceUpdatedAt,
      totalItems,
      processedItems: processedItems + batch.length,
      passStartedAt,
      refusedWrites,
    });
    return { processed: batch.length };
  }
  await recordPassOutcome(refusedWrites);
  return { processed: batch.length };
}

/**
 * The flag is volume-global: refusals from live misses drain into whichever pass ends
 * next, and a clean pass clears what a still-refusing pass re-sets on its own end.
 * Accepted, since one pass heals it either way.
 */
async function recordPassOutcome(refusedWrites: number): Promise<void> {
  const redis = getRedis();
  if (refusedWrites > 0) {
    await writeDiskLimited(redis, refusedWrites);
    console.warn(`[ImagePrecache] pass ended disk-limited: ${refusedWrites} writes refused`);
  } else {
    await clearDiskLimited(redis);
  }
}

/**
 * Active precache passes for the running-tasks UI. A pass is a chain of
 * batch jobs; at any moment the chain has at most one live job per server
 * carrying cumulative pass progress in its data. Delayed jobs are the
 * sync-active backoff and count as pending, not running.
 */
export async function getAllActiveImagePrecacheJobs(): Promise<
  Array<{
    jobId: string;
    serverId: string;
    state: string;
    createdAt: number;
    passStartedAt: string | null;
    totalItems: number | null;
    processedItems: number;
    diskLimited: boolean;
  }>
> {
  if (!imagePrecacheQueue) {
    return [];
  }

  const jobs = await imagePrecacheQueue.getJobs(['active', 'waiting', 'delayed']);
  const limited = await readDiskLimited(getRedis()).catch(() => null);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        state,
        createdAt: job.timestamp ?? Date.now(),
        passStartedAt: job.data.passStartedAt ?? null,
        totalItems: job.data.totalItems ?? null,
        processedItems: job.data.processedItems ?? 0,
        diskLimited: limited !== null,
      };
    })
  );
}

/**
 * Gracefully shut down the image precache queue and worker.
 */
export async function shutdownImagePrecacheQueue(): Promise<void> {
  console.log('[ImagePrecache] Shutting down...');

  if (imagePrecacheWorker) {
    await imagePrecacheWorker.close();
    imagePrecacheWorker = null;
  }

  if (imagePrecacheQueue) {
    await imagePrecacheQueue.close();
    imagePrecacheQueue = null;
  }

  connectionOptions = null;

  console.log('[ImagePrecache] Shutdown complete');
}
