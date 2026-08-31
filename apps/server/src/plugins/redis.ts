/**
 * Redis client plugin for Fastify
 *
 * Uses lazyConnect so the plugin can be registered even when Redis
 * is unreachable. Call connectRedis(app) to actually establish the connection.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { setRedisPrefix } from '@tracearr/shared';
import { isMaintenance } from '../serverState.js';
import { setSharedRedis } from '../lib/redisShared.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const redisPlugin: FastifyPluginAsync = async (app) => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisPrefix = process.env.REDIS_PREFIX ?? '';
  if (redisPrefix) {
    setRedisPrefix(redisPrefix);
    app.log.info({ prefix: redisPrefix }, 'Redis key prefix configured');
  }

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError(err: Error) {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
  });

  redis.on('connect', () => {
    app.log.info('Redis connected');
  });

  redis.on('error', (err: Error) => {
    // Suppress reconnection errors during maintenance — the recovery loop
    // handles probing and will log when services are back.
    if (!isMaintenance()) {
      app.log.error({ err }, 'Redis error');
    }
  });

  app.decorate('redis', redis);
  // Better Auth and the Plex plugin resolve their client through this, so they
  // inherit the retry policy and the maintenance-aware error handler above.
  setSharedRedis(redis);

  app.addHook('onClose', async () => {
    if (redis.status === 'ready' || redis.status === 'connecting') {
      await redis.quit();
    }
  });
};

/**
 * Explicitly connect the Redis client decorated on the Fastify instance.
 * Call this after verifying Redis is reachable.
 */
export async function connectRedis(app: FastifyInstance): Promise<void> {
  if (app.redis.status === 'ready') return;
  await app.redis.connect();
}

export default fp(redisPlugin, {
  name: 'redis',
});
