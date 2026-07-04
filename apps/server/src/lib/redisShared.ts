/**
 * Shared ioredis client for the Better Auth instance and its plugins.
 *
 * Constructed lazily so Phase 1 startup (building the Fastify app) succeeds
 * without a reachable Redis. The Better Auth secondary storage and the Plex
 * login plugin both use this single connection.
 */

import { Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
