/**
 * Email-optional local sign-up integration tests (POST /sign-up/username)
 *
 * Drives the REAL Better Auth handler (signupPlugin.ts registered in
 * lib/auth.ts) against a real database, mirroring
 * betterAuthSignup.integration.test.ts's structure for the built-in
 * /sign-up/email endpoint. Covers the behaviors the email-optional signup
 * story specifically calls out:
 *   - signing up with no email stores NULL (never '')
 *   - signing up with an email still works (email stays optional, not removed)
 *   - two email-less users can coexist under users_email_unique (Postgres
 *     treats every NULL as distinct in a unique index)
 *   - an email-less user can sign in afterwards by username
 *   - an empty-string equality lookup never matches a NULL-email row (no
 *     identity-matching collision between two email-less accounts)
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { eq, isNull } from 'drizzle-orm';
import { API_BASE_PATH } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { closeAuth } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { createTestApp } from '../../src/test/helpers.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = await createTestApp();
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });

  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });

  return app;
}

describe('better auth email-optional sign-up (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Same Redis cleanup betterAuthSignup.integration.test.ts does: sign-up
    // mints a session whose secondary-storage keys land in the shared test
    // Redis, which the redis-prefix canary test would otherwise flag.
    const redis = getRedis();
    const baKeys = await redis.keys(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*`);
    if (baKeys.length > 0) {
      await redis.del(...baKeys);
    }
    await closeAuth();
  });

  it('creates the first owner with no email, storing NULL rather than an empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'No Email Owner',
        username: 'noemailowner',
        password: 'NoEmailOwner!12345',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.role).toBe('owner');
    expect(body.user.email).toBeNull();

    const [row] = await db.select().from(users).where(eq(users.username, 'noemailowner'));
    expect(row).toBeDefined();
    expect(row!.email).toBeNull();
    expect(row!.email).not.toBe('');
    expect(row!.role).toBe('owner');
  });

  it('still supports signing up with an email (optional, not removed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Email Owner',
        username: 'emailowner',
        email: 'Owner@Example.com',
        password: 'EmailOwner!12345',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('owner@example.com');

    const [row] = await db.select().from(users).where(eq(users.username, 'emailowner'));
    expect(row!.email).toBe('owner@example.com');
  });

  it('lets an email-less user sign in afterwards by username', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Sign In Owner',
        username: 'signinowner',
        password: 'SignInOwner!12345',
      },
    });
    expect(signUp.statusCode).toBe(200);

    const signIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/username`,
      headers: { 'content-type': 'application/json' },
      payload: { username: 'signinowner', password: 'SignInOwner!12345' },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().user.email).toBeNull();
  });

  it('rejects a second local sign-up once an owner exists, email or not', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: { name: 'First Owner', username: 'firstowner', password: 'FirstOwner!12345' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Second Owner', username: 'secondowner', password: 'SecondOwner!12345' },
    });
    expect(second.statusCode).toBe(403);
  });

  it('allows two email-less identities to coexist (no users_email_unique NULL collision)', async () => {
    // The owner, created email-less via the real endpoint under test.
    const signUp = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/username`,
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Coexist Owner', username: 'coexistowner', password: 'CoexistOwner!123' },
    });
    expect(signUp.statusCode).toBe(200);

    // A second email-less identity, inserted the way a media-server sync
    // would (userService.createUser/syncUserFromMediaServer) - a distinct
    // human with no email on their media-server account. This must NOT
    // violate users_email_unique just because both rows have NULL email.
    await expect(
      db.insert(users).values({ username: 'noemailmember', email: null, role: 'member' })
    ).resolves.not.toThrow();

    const nullEmailRows = await db.select().from(users).where(isNull(users.email));
    expect(nullEmailRows.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(nullEmailRows.map((r) => r.id));
    expect(ids.size).toBe(nullEmailRows.length); // every row distinct, none merged

    // An equality lookup on '' must never match either NULL row - proves the
    // identity-matching cascade's `eq(users.email, someValue)` can't
    // accidentally treat "no email" as the literal value ''.
    const emptyStringMatches = await db.select().from(users).where(eq(users.email, ''));
    expect(emptyStringMatches).toHaveLength(0);
  });
});
