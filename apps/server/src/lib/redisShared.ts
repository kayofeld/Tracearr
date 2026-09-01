/**
 * Redis accessor for the Better Auth instance, the Plex login plugin, and the
 * SSE stats recorder. Prefers the Fastify plugin's client (see plugins/redis.ts)
 * so the process holds one connection with one retry policy and one error handler.
 */

import { Redis } from 'ioredis';

/** The Fastify plugin's client. Owned by the plugin - closeRedis must not quit it. */
let injected: Redis | null = null;
/** Only created when nothing injected a client: scripts and unit tests. */
let fallback: Redis | null = null;

export function setSharedRedis(redis: Redis): void {
  injected = redis;
}

export function getRedis(): Redis {
  if (injected) return injected;
  fallback ??= new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return fallback;
}

export async function closeRedis(): Promise<void> {
  if (fallback) {
    await fallback.quit();
    fallback = null;
  }
}
