/**
 * Better Auth, the Plex login plugin and the SSE stats recorder resolve their
 * client through getRedis(). They used to get a second connection with its own
 * retry policy and no error handler, so a Redis outage logged outside the app
 * logger and stalled auth for 20 retries per command instead of 3.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import redisPlugin from '../../plugins/redis.js';
import { getRedis, setSharedRedis, closeRedis } from '../redisShared.js';

describe('shared Redis client', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(async () => {
    await closeRedis();
  });

  it('hands out the Fastify plugin client once the plugin is registered', async () => {
    const app = Fastify();
    await app.register(redisPlugin);

    expect(getRedis()).toBe(app.redis);

    await app.close();
  });

  it('does not quit the injected client - the plugin onClose hook owns it', async () => {
    const injected = new Redis({ lazyConnect: true });
    setSharedRedis(injected);

    await closeRedis();

    expect(injected.status).not.toBe('end');
    expect(getRedis()).toBe(injected);
    injected.disconnect();
  });
});
