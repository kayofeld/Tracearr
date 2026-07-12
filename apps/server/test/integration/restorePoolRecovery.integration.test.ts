import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { API_BASE_PATH } from '@tracearr/shared';
import { closeDatabase } from '../../src/db/client.js';
import { closeAuth } from '../../src/lib/auth.js';
import { reinitDatabaseConsumers } from '../../src/services/restoreOrchestrator.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import authPlugin from '../../src/plugins/auth.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  await app.register(fastifyCookie, { secret: 'test-cookie-secret-32-chars-long!' });
  await app.register(rateLimit, { max: 10000, timeWindow: '1 minute' });
  await app.register(authPlugin);

  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });

  return app;
}

async function signUpOwner(app: FastifyInstance) {
  const email = `owner-${randomUUID()}@example.com`;
  const password = 'OwnerPassword!123';
  const username = `owner${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const res = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-up/email`,
    headers: { 'content-type': 'application/json' },
    payload: { email, password, name: 'Restore Owner', username },
  });
  expect(res.statusCode).toBe(200);
  return { email, password };
}

function signIn(app: FastifyInstance, email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-in/email`,
    headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
}

async function clearRedisPattern(pattern: string): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

describe('restore pool recovery (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-in*`);
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    const redis = getRedis();
    const keys = await redis.keys(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*`);
    if (keys.length > 0) await redis.del(...keys);
    await closeAuth();
  });

  it('login works again after a successful-restore-style pool teardown and reinit', async () => {
    const { email, password } = await signUpOwner(app);

    try {
      await closeDatabase();

      const duringOutage = await signIn(app, email, password);
      expect(duringOutage.statusCode).toBe(500);
    } finally {
      await reinitDatabaseConsumers();
    }

    const afterRecovery = await signIn(app, email, password);
    expect(afterRecovery.statusCode).toBe(200);
  });

  it('login works again after a failed-restore-style pool teardown with repeated reinit attempts', async () => {
    const { email, password } = await signUpOwner(app);

    await closeDatabase();
    await reinitDatabaseConsumers();
    await closeDatabase();
    await reinitDatabaseConsumers();

    const afterRecovery = await signIn(app, email, password);
    expect(afterRecovery.statusCode).toBe(200);
  });
});
