/**
 * Shared BullMQ wiring for the queue modules.
 *
 * The prefix has to match between a Queue and its Worker or they operate on
 * different keyspaces, so it is computed in one place rather than per module.
 */

import type { ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';

/** BullMQ opens its own connections from these - workers need blocking ones. */
export function queueConnectionOptions(redisUrl: string): ConnectionOptions {
  return { url: redisUrl };
}

/** Read per call, not cached: index.ts sets REDIS_PREFIX before any queue starts. */
export function getBullPrefix(): string {
  return `${getRedisPrefix()}bull`;
}
