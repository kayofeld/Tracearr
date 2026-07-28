/**
 * Better Auth first-owner sign-up integration tests
 *
 * Drives the REAL Better Auth email/password sign-up endpoint against a real
 * database to guard the fresh-install setup flow. Regression coverage for the
 * uuid id mismatch: users.id is a uuid column, so Better Auth must mint a
 * UUID-format id (advanced.database.generateId in lib/auth.ts) instead of its
 * default nanoid, which Postgres rejects with 22P02.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { API_BASE_PATH } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { getAuth, closeAuth } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { createTestApp } from '../../src/test/helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mounts the real Better Auth handler under the production auth prefix using
// the production wildcard handler from index.ts. No Origin/cookie headers are
// sent from these programmatic requests, so Better Auth's trusted-origin CSRF
// check does not fire.
async function buildApp(): Promise<FastifyInstance> {
  const app = await createTestApp();
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });

  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    // Better Auth's own internal rate limiter now defaults to enabled (see
    // BuildAuthOptions.rateLimit in lib/auth.ts) - and its built-in rule caps
    // /sign-up* at 3 requests per 10s. This suite's getAuth() singleton is
    // shared across every `it()` in the file (only reset in afterAll), so
    // without this explicit opt-out the later sign-ups here would start
    // failing with 429s that have nothing to do with the behavior under
    // test. Disabled here, not via an env var - production keeps the
    // limiter on by default.
    handler: createBetterAuthHandler(() => getAuth({ rateLimit: false })),
  });

  return app;
}

describe('better auth first-owner sign-up (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Sign-up mints a Better Auth session whose secondary-storage keys land in
    // the shared test Redis. Clear them so the redis-prefix canary test does not
    // flag these bare tracearr:ba:* keys as unprefixed leaks.
    const redis = getRedis();
    const baKeys = await redis.keys(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*`);
    if (baKeys.length > 0) {
      await redis.del(...baKeys);
    }
    await closeAuth();
  });

  it('creates the first owner with a valid uuid id on a clean database', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'first-owner@example.com',
        password: 'FirstOwner!12345',
        name: 'First Owner',
        username: 'firstowner',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toMatch(UUID_RE);
    expect(body.user.role).toBe('owner');

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(UUID_RE);
    expect(rows[0]!.role).toBe('owner');
    expect(rows[0]!.email).toBe('first-owner@example.com');
  });

  it('rejects a second sign-up once an owner exists', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'owner-one@example.com',
        password: 'OwnerOne!12345',
        name: 'Owner One',
        username: 'ownerone',
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'owner-two@example.com',
        password: 'OwnerTwo!12345',
        name: 'Owner Two',
        username: 'ownertwo',
      },
    });
    expect(second.statusCode).toBe(403);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
