/**
 * Kill Queue - BullMQ-based delayed stream termination with re-verification
 *
 * kill_stream actions enqueue here instead of terminating inline. delay_seconds
 * (0 if unset) becomes the sustain window: the worker waits that long, then
 * calls reverifyKillCondition to check the match still holds against current
 * state before actually terminating. This closes the gap where a rule match
 * and the kill itself used to happen in the same instant with no chance for
 * the underlying condition to have already cleared.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix, type Action } from '@tracearr/shared';
import type { ActionResult } from '../services/rules/executors/index.js';
import { isMaintenance } from '../serverState.js';
import {
  reverifyKillCondition,
  type ReverifyKillConditionResult,
} from '../services/rules/reverify.js';
import { storeActionResults } from '../services/rules/v2Integration.js';

const QUEUE_NAME = 'kill-stream';

export interface KillJobData {
  sessionId: string;
  serverId: string;
  ruleId: string;
  /** Violation the kill_stream match created; null when the match created no violation. */
  violationId: string | null;
  message?: string;
}

let connectionOptions: ConnectionOptions | null = null;
let killQueue: Queue<KillJobData> | null = null;
let killWorker: Worker<KillJobData> | null = null;

/**
 * Initialize the kill queue with a Redis connection.
 */
export function initKillQueue(redisUrl: string): void {
  if (killQueue) {
    console.log('[KillQueue] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  const bullPrefix = `${getRedisPrefix()}bull`;

  killQueue = new Queue<KillJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s
      },
      removeOnComplete: {
        count: 500,
        age: 24 * 60 * 60, // 24h
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  killQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[KillQueue] Queue error:', err);
  });

  console.log('[KillQueue] Queue initialized');
}

/**
 * Start the kill worker to process queued jobs.
 */
export function startKillWorker(): void {
  if (!connectionOptions) {
    throw new Error('Kill queue not initialized. Call initKillQueue first.');
  }

  if (killWorker) {
    console.log('[KillQueue] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  killWorker = new Worker<KillJobData>(
    QUEUE_NAME,
    async (job: Job<KillJobData>) => {
      const startTime = Date.now();
      try {
        await processKillJob(job);
        console.log(`[KillQueue] Job ${job.id} processed in ${Date.now() - startTime}ms`);
      } catch (error) {
        console.error(`[KillQueue] Job ${job.id} failed after ${Date.now() - startTime}ms:`, error);
        throw error; // Re-throw to trigger BullMQ retry
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 5,
    }
  );

  killWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[KillQueue] Worker error:', error);
  });

  console.log('[KillQueue] Worker started');
}

/** Map a reverify outcome to the ActionResult shape storeActionResults persists. */
function outcomeToActionResult(result: ReverifyKillConditionResult): ActionResult {
  const action: Action = { type: 'kill_stream' };

  if (result.outcome === 'killed') {
    return { action, success: true, skipped: false, message: 'killed' };
  }
  if (result.outcome === 'failed') {
    return { action, success: false, message: result.error ?? 'failed' };
  }
  return { action, success: true, skipped: true, skipReason: result.outcome };
}

/**
 * Process a single kill job: re-verify against current state, terminate if
 * still warranted, and persist the outcome against the originating violation.
 */
export async function processKillJob(job: Job<KillJobData>): Promise<void> {
  const { sessionId, serverId, ruleId, violationId, message } = job.data;

  const result = await reverifyKillCondition({ sessionId, serverId, ruleId, message });

  await storeActionResults(violationId, ruleId, [outcomeToActionResult(result)]);
}

function buildJobId(violationId: string | null, sessionId: string, ruleId: string): string {
  // Without a violationId, two different rule matches on the same session
  // would otherwise collide on `kill:null:<sessionId>` and dedupe each other.
  if (violationId) return `kill:${violationId}:${sessionId}`;
  return `kill:rule:${ruleId}:${sessionId}`;
}

/**
 * Enqueue a kill for delayed, re-verified termination.
 * Returns the job ID if enqueued, or undefined if deduplicated/dropped.
 */
export async function enqueueKill(
  data: KillJobData,
  delaySeconds: number
): Promise<string | undefined> {
  if (!killQueue) {
    console.error('[KillQueue] Queue not initialized, dropping kill job');
    return undefined;
  }

  const jobId = buildJobId(data.violationId, data.sessionId, data.ruleId);

  try {
    const job = await killQueue.add('kill', data, {
      jobId,
      delay: Math.max(0, delaySeconds) * 1000,
    });

    return job.id;
  } catch (error) {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      const isDuplicateError =
        msg.includes('job with id') || msg.includes('already exists') || msg.includes('duplicate');

      if (isDuplicateError) {
        console.debug(`[KillQueue] Deduplicated kill job (jobId: ${jobId})`);
        return undefined;
      }
    }
    throw error;
  }
}

/**
 * Gracefully shut down the kill queue and worker.
 */
export async function shutdownKillQueue(): Promise<void> {
  console.log('[KillQueue] Shutting down...');

  if (killWorker) {
    await killWorker.close();
    killWorker = null;
  }

  if (killQueue) {
    await killQueue.close();
    killQueue = null;
  }

  connectionOptions = null;

  console.log('[KillQueue] Shutdown complete');
}
