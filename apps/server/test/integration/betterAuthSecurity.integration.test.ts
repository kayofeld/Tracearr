/**
 * Better Auth adversarial security tests (integration)
 *
 * Drives the REAL Better Auth handler, the real dual-verify auth plugin, and
 * the real mobile routes against a real database and a real Redis instance
 * (no mocks for the pieces under test - only media servers/push would be
 * mocked, and none of these flows touch either). Lives under test/integration
 * (not src/**\/*.security.test.ts) because that config's setup file
 * (src/test/setup.ts) never points at the test-stack DATABASE_URL/REDIS_URL -
 * it hardcodes a different DB on the dev Postgres port - and its CI job runs
 * with no DB/Redis services at all. Real-state auth security assertions need
 * the integration setup (src/test/setup.integration.ts), exactly like the
 * existing betterAuthRevocation/betterAuthSignup/mobile integration tests.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { API_BASE_PATH } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  users,
  authAccounts,
  authSessions,
  authVerifications,
  plexAccounts,
  mobileSessions,
} from '../../src/db/schema.js';
import { closeAuth } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { setSetting } from '../../src/services/settings.js';
import { hashPassword } from '../../src/utils/password.js';
import authPlugin from '../../src/plugins/auth.js';
import { authRoutes } from '../../src/routes/auth/index.js';
import { mobileRoutes } from '../../src/routes/mobile.js';
import { resolveSocketUser, checkMobileBlacklist } from '../../src/websocket/index.js';
import { enableLocalLoginCommand } from '../../scripts/lib/commands.js';
import { assertSignupAllowed } from '../../src/lib/authGuards.js';
import { PlexClient } from '../../src/services/mediaServer/index.js';

/** Rebuilds a Cookie header from a set-cookie response array (name=value only). */
function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function setCookieArray(res: { headers: { 'set-cookie'?: string | string[] } }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function clearRedisPattern(pattern: string): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  await app.register(fastifyCookie, { secret: 'test-cookie-secret-32-chars-long!' });
  await app.register(rateLimit, { max: 10000, timeWindow: '1 minute' });
  app.decorate('redis', getRedis());
  await app.register(authPlugin);

  // Mirrors index.ts: the Better Auth wildcard (via the shared production
  // handler), then the static legacy auth routes (which win over the wildcard
  // for their exact paths), then mobile.
  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });
  await app.register(authRoutes, { prefix: `${API_BASE_PATH}/auth` });
  await app.register(mobileRoutes, { prefix: `${API_BASE_PATH}/mobile` });

  app.get('/protected', { preHandler: [app.authenticate] }, async (request) => ({
    userId: request.user.userId,
    role: request.user.role,
  }));

  app.get(
    '/protected-public-api',
    { preHandler: [app.authenticatePublicApi] },
    async (request) => ({
      userId: request.publicApiContext!.userId,
    })
  );

  return app;
}

async function signUpOwner(
  app: FastifyInstance,
  overrides: { email?: string; username?: string; password?: string } = {}
) {
  const email = overrides.email ?? `owner-${randomUUID()}@example.com`;
  const password = overrides.password ?? 'OwnerPassword!123';
  const username = overrides.username ?? `owner${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const res = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-up/email`,
    headers: { 'content-type': 'application/json' },
    payload: { email, password, name: 'Security Owner', username },
  });
  expect(res.statusCode).toBe(200);
  return { email, password, username, userId: res.json().user.id as string, res };
}

describe('better auth security (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    // Rate-limit counters live in Redis and are NOT reset by the per-test DB
    // truncation, so clear anything from a previous test that could bleed
    // into this one (the sign-in/sign-up special rule is shared per path).
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-in*`);
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Pairing/rate-limit calls in these tests leave Redis keys behind
    // (tracearr:ba:*, tracearr:mobile:*, tracearr:mobile_refresh:*,
    // mobile_token_gen:*, tracearr:ratelimit:mobile:*) that would otherwise
    // survive long enough for the redis-prefix canary test to flag them as
    // unprefixed leaks. The mobile_refresh keys carry a 90-day TTL, so
    // without this cleanup they poison the shared test Redis across runs.
    const redis = getRedis();
    const prefix = process.env.REDIS_PREFIX ?? '';
    const patterns = [
      `${prefix}tracearr:ba:*`,
      `${prefix}tracearr:mobile:*`,
      `${prefix}tracearr:mobile_refresh:*`,
      `${prefix}mobile_token_gen:*`,
      `${prefix}tracearr:ratelimit:mobile:*`,
    ];
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await closeAuth();
  });

  it('session cookie is httpOnly and sameSite', async () => {
    const { res } = await signUpOwner(app);
    const cookies = setCookieArray(res);
    const sessionCookie = cookies.find((c) => c.includes('session_token'));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('sign-in rotates the session token (no fixation)', async () => {
    const { email, password } = await signUpOwner(app);

    const firstSignIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(firstSignIn.statusCode).toBe(200);
    const tokenA = firstSignIn.json().token as string;

    const secondSignIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(secondSignIn.statusCode).toBe(200);
    const tokenB = secondSignIn.json().token as string;

    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).not.toBe(tokenB);
  });

  it('username sign-in and sign-up ignore member rows sharing the username', async () => {
    // Synced member rows live in the same users table and can carry any
    // username, including one equal to a login username. They must never
    // shadow the login-capable account: the owner can still claim the
    // username at sign-up and always wins the sign-in lookup.
    const username = `shadow${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await db.insert(users).values({ username, role: 'member' });

    const { password, userId } = await signUpOwner(app, { username });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/username`,
      headers: { 'content-type': 'application/json' },
      payload: { username, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
  });

  it('rate limits repeated failed sign-ins', async () => {
    // Default better-auth special rule for /sign-in* is window 10s, max 3.
    // The account doesn't need to exist - the rate limiter fires purely on
    // path, before credential lookup.
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/sign-in/email`,
        headers: { 'content-type': 'application/json' },
        payload: { email: 'nobody@example.com', password: 'WrongPassword!123' },
      });

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await attempt();
      codes.push(res.statusCode);
    }

    expect(codes).toContain(429);
    // Everything before the limit trips should be a normal auth failure, not
    // a crash or an accidental pass-through.
    expect(codes.slice(0, codes.indexOf(429))).not.toContain(500);
  });

  it('a disabled-role user cannot obtain a session', async () => {
    const password = 'DisabledUser!123';
    const email = `disabled-${randomUUID()}@example.com`;

    const [user] = await db
      .insert(users)
      .values({
        username: `disabled${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        email,
        emailVerified: true,
        role: 'disabled',
      })
      .returning();
    expect(user).toBeDefined();

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: user!.id,
      providerId: 'credential',
      userId: user!.id,
      password: await hashPassword(password),
    });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });

    expect(res.statusCode).toBe(403);

    const rows = await db.select().from(users).where(eq(users.id, user!.id));
    expect(rows).toHaveLength(1); // sanity: user still exists, just can't log in
  });

  it('jellyfin login endpoint stays gone', async () => {
    const removed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/jellyfin/login`,
      payload: { username: 'x', password: 'y' },
    });
    expect(removed.statusCode).toBe(404);

    // The legacy static route it used to share a file with must still win
    // over the Better Auth wildcard for its own exact path.
    const stillThere = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/jellyfin/connect-api-key`,
      payload: {},
    });
    expect(stillThere.statusCode).not.toBe(404);
  });

  it('cli enable-local-login recovers from local login disabled', async () => {
    const { email, password } = await signUpOwner(app);

    await setSetting('localLoginEnabled', false);
    const blocked = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(blocked.statusCode).toBe(403);

    await enableLocalLoginCommand();

    const recovered = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(recovered.statusCode).toBe(200);
  });

  it('rejects a forged/garbage session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: 'better-auth.session_token=not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('revoked mobile device is denied on http and rejected at socket auth', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));
    await setSetting('mobileEnabled', true);

    const tokenRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair-token`,
      headers: { cookie: ownerCookie },
    });
    expect(tokenRes.statusCode).toBe(200);
    const pairingToken = tokenRes.json().token as string;

    const pairRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair`,
      payload: {
        token: pairingToken,
        deviceName: 'Security Test Device',
        deviceId: `device-${randomUUID()}`,
        platform: 'ios',
      },
    });
    expect(pairRes.statusCode).toBe(200);
    const { accessToken } = pairRes.json();

    const [sessionRow] = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.userId, owner.userId));
    expect(sessionRow).toBeDefined();

    // Sanity: the freshly paired device works over HTTP and resolves at the
    // socket auth layer, and isn't blacklisted yet.
    const meBefore = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meBefore.statusCode).toBe(200);

    const socketUserBefore = await resolveSocketUser({ token: accessToken, headers: {} });
    expect(socketUserBefore).toMatchObject({ mobile: true, deviceId: sessionRow!.deviceId });

    // checkMobileBlacklist returns "allowed" (true = allowed, not blacklisted).
    const allowedBefore = await checkMobileBlacklist(getRedis(), sessionRow!.deviceId);
    expect(allowedBefore).toBe(true);

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/mobile/sessions/${sessionRow!.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(revokeRes.statusCode).toBe(200);

    const meAfter = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meAfter.statusCode).toBe(401);

    const socketUserAfter = await resolveSocketUser({ token: accessToken, headers: {} });
    expect(socketUserAfter).toBeNull();

    const allowedAfter = await checkMobileBlacklist(getRedis(), sessionRow!.deviceId);
    expect(allowedAfter).toBe(false);
  });

  // The second-sign-up-over-the-endpoint case lives in
  // betterAuthSignup.integration.test.ts ('rejects a second sign-up once an
  // owner exists'); this file only covers the shared guard below.
  it('single-owner gate: assertSignupAllowed (shared by every creation path) rejects once an owner exists', async () => {
    // Every user-creation entry point funnels through this same guard:
    // email/password sign-up via the databaseHooks.user.create.before hook
    // (lib/auth.ts), and the Plex first-run flow via a direct call in
    // plexPlugin.ts (plex/check-pin and plex/connect, before creating the
    // temp token / user row). OIDC's first-user path is covered by the very
    // same databaseHooks.user.create.before hook that gates email/password
    // sign-up above, since Better Auth's adapter create path is shared across
    // credential and OAuth providers - there's no separate hook to bypass.
    // Driving that path live would require a real IdP redirect round-trip,
    // which isn't available in this environment, so this test exercises the
    // guard function directly against the live database instead.
    await expect(assertSignupAllowed()).resolves.toBeUndefined();

    await signUpOwner(app);

    await expect(assertSignupAllowed()).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('sign-up payload cannot inject role/trust score/violations/apiToken via additionalFields', async () => {
    // additionalFields in lib/auth.ts all declare input: false, but Better
    // Auth enforces that two different ways depending on the field:
    // - 'role' collides with a name the admin plugin itself guards, and gets
    //   hard-rejected before a row is ever created (400 FIELD_NOT_ALLOWED).
    // - the others are silently stripped from the input and the row is
    //   created with their defaultValue instead.
    // Either outcome is safe; what matters is the attacker-supplied value
    // never lands in the database, so both are asserted per field below.
    const maliciousFields: Record<string, unknown> = {
      role: 'admin',
      aggregateTrustScore: 999999,
      totalViolations: 999,
      apiToken: `trr_pub_${randomUUID().replace(/-/g, '')}`,
    };

    for (const [field, value] of Object.entries(maliciousFields)) {
      // Better Auth's own sign-up rate limit is tight enough that the four
      // rapid-fire attempts in this loop would otherwise trip it.
      await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);

      const email = `escalate-${field}-${randomUUID()}@example.com`;
      const username = `esc${randomUUID().replace(/-/g, '').slice(0, 12)}`;

      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/sign-up/email`,
        headers: { 'content-type': 'application/json' },
        payload: {
          email,
          password: 'Escalate!12345',
          name: 'Escalate Test',
          username,
          [field]: value,
        },
      });

      const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

      if (res.statusCode === 200) {
        expect(rows).toHaveLength(1);
        expect((rows[0] as unknown as Record<string, unknown>)[field]).not.toBe(value);
        // A successful iteration becomes the instance owner, which would
        // block every later iteration's sign-up on the unrelated
        // single-owner gate rather than the field-injection guard this test
        // targets - remove it so each field is tested against a clean slate.
        await db.delete(users).where(eq(users.email, email.toLowerCase()));
      } else {
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('FIELD_NOT_ALLOWED');
        expect(rows).toHaveLength(0);
      }
    }

    // Sanity: the same shape signs up fine, with safe defaults, once the
    // attacker-controlled fields are removed.
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);
    const email = `legit-${randomUUID()}@example.com`;
    const username = `legit${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password: 'Escalate!12345', name: 'Escalate Test', username },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row!.role).toBe('owner'); // forced by the create hook for the first user
    expect(row!.aggregateTrustScore).toBe(100);
    expect(row!.totalViolations).toBe(0);
    expect(row!.apiToken).toBeNull();
  });

  it('a public API token cannot be used as a Better Auth session/bearer, and vice versa', async () => {
    const owner = await signUpOwner(app);

    const signIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email: owner.email, password: owner.password },
    });
    expect(signIn.statusCode).toBe(200);
    const baBearerToken = signIn.json().token as string;
    expect(baBearerToken).toBeTruthy();

    const publicApiToken = `trr_pub_${randomUUID().replace(/-/g, '')}`;
    await db.update(users).set({ apiToken: publicApiToken }).where(eq(users.id, owner.userId));

    // The public API token authenticates the public API path...
    const publicApiWithPublicToken = await app.inject({
      method: 'GET',
      url: '/protected-public-api',
      headers: { authorization: `Bearer ${publicApiToken}` },
    });
    expect(publicApiWithPublicToken.statusCode).toBe(200);
    expect(publicApiWithPublicToken.json().userId).toBe(owner.userId);

    // ...but is NOT accepted as a Better Auth session/bearer on a protected route.
    const protectedWithPublicToken = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${publicApiToken}` },
    });
    expect(protectedWithPublicToken.statusCode).toBe(401);

    // And a real Better Auth bearer session token is NOT accepted as a public API key.
    const publicApiWithBaBearer = await app.inject({
      method: 'GET',
      url: '/protected-public-api',
      headers: { authorization: `Bearer ${baBearerToken}` },
    });
    expect(publicApiWithBaBearer.statusCode).toBe(401);
  });

  it('a tampered mobile bearer token is rejected', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));
    await setSetting('mobileEnabled', true);

    const tokenRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair-token`,
      headers: { cookie: ownerCookie },
    });
    expect(tokenRes.statusCode).toBe(200);
    const pairingToken = tokenRes.json().token as string;

    const pairRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair`,
      payload: {
        token: pairingToken,
        deviceName: 'Tamper Test Device',
        deviceId: `device-${randomUUID()}`,
        platform: 'ios',
      },
    });
    expect(pairRes.statusCode).toBe(200);
    const { accessToken } = pairRes.json() as { accessToken: string };

    const mid = Math.floor(accessToken.length / 2);
    const flippedChar = accessToken[mid] === 'a' ? 'b' : 'a';
    const tampered = accessToken.slice(0, mid) + flippedChar + accessToken.slice(mid + 1);
    expect(tampered).not.toBe(accessToken);

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('plex login guard rejects a non-owner even with an allowLogin=true plex_accounts row (only plex.tv mocked)', async () => {
    await signUpOwner(app);

    const [nonOwner] = await db
      .insert(users)
      .values({
        username: `nonowner${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        email: `nonowner-${randomUUID()}@example.com`,
        emailVerified: true,
        role: 'viewer',
      })
      .returning();
    expect(nonOwner).toBeDefined();

    const plexAccountId = `plex-${randomUUID()}`;
    await db.insert(plexAccounts).values({
      userId: nonOwner!.id,
      plexAccountId,
      plexUsername: 'nonowner',
      plexEmail: nonOwner!.email!,
      plexThumbnail: '',
      plexToken: 'fake-plex-token',
      // allowLogin: true on its own must not be enough to authorize login -
      // the plexPlugin's role !== 'owner' check is the actual gate.
      allowLogin: true,
    });

    // Only the plex.tv client is mocked (per contract); db and the plugin's
    // own guard logic run for real against the live database.
    const spy = vi.spyOn(PlexClient, 'checkOAuthPin').mockResolvedValue({
      id: plexAccountId,
      username: 'nonowner',
      email: nonOwner!.email!,
      thumb: '',
      token: 'fake-plex-token',
      tokenKind: 'legacy',
      refreshToken: null,
      expiresAt: null,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/plex/check-pin`,
        headers: { 'content-type': 'application/json' },
        payload: { pinId: 'fake-pin-id' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });

  it('an expired session is rejected', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));

    const before = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: ownerCookie },
    });
    expect(before.statusCode).toBe(200);

    const [sessionRow] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, owner.userId));
    expect(sessionRow).toBeDefined();

    // The session cookie itself is HMAC-signed (better-auth/cookies), so a
    // fresh row can't be forged with a valid cookie from scratch - instead,
    // age out the *real* session this cookie already points at. The session
    // is also cached in the secondaryStorage Redis (lib/auth.ts), which is
    // consulted ahead of the database, so - exactly like the
    // revocation-is-immediate test - both the DB row and its Redis cache
    // entry have to reflect the expiry for the change to actually take
    // effect on the next request.
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(authSessions.userId, owner.userId));
    const prefix = process.env.REDIS_PREFIX ?? '';
    await getRedis().del(`${prefix}tracearr:ba:${sessionRow!.token}`);

    const after = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: ownerCookie },
    });
    expect(after.statusCode).toBe(401);
  });

  describe('cross-origin / CSRF origin check', () => {
    // NODE_ENV=test makes Better Auth's own createContext default
    // advanced.disableOriginCheck to true (see its isTest() check), so the
    // getAuth() singleton used everywhere else in this file - and in the
    // running app in general under this test harness - never enforces the
    // origin check at all. That default is Better Auth's, not this app's;
    // outside of NODE_ENV=test it defaults to enabled. To observe the real
    // code path this app relies on in production, this test builds a second,
    // disposable auth instance against the same live database with the
    // check explicitly forced on (advanced.disableOriginCheck: false) and a
    // known trustedOrigins list, otherwise matching lib/auth.ts.
    const trustedOrigin = 'https://trusted.example.com';
    const originCheckAuth = betterAuth({
      basePath: '/api/v1/auth',
      secret: 'test-better-auth-secret-32-chars!!',
      trustedOrigins: [trustedOrigin],
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: users,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
        },
      }),
      advanced: {
        database: { generateId: () => randomUUID() },
        disableOriginCheck: false,
      },
      emailAndPassword: { enabled: true },
    });

    async function signInWithOrigin(origin: string | undefined, withCookie: boolean) {
      const url = `http://localhost${API_BASE_PATH}/auth/sign-in/email`;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (origin) headers.set('origin', origin);
      if (withCookie) headers.set('cookie', 'session-probe=1');
      const req = new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'nobody@example.com', password: 'WrongPassword!123' }),
      });
      return originCheckAuth.handler(req);
    }

    it('rejects a cookie-bearing request from a disallowed origin', async () => {
      const res = await signInWithOrigin('https://evil.example.com', true);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('INVALID_ORIGIN');
    });

    it('rejects a request with an Origin header from a disallowed origin even without a cookie', async () => {
      // Better Auth's form-CSRF middleware force-validates whenever an
      // Origin header is present at all, cookie or not.
      const res = await signInWithOrigin('https://evil.example.com', false);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('INVALID_ORIGIN');
    });

    it('accepts a cookie-bearing request from a trusted origin (reaches real credential check)', async () => {
      const res = await signInWithOrigin(trustedOrigin, true);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('INVALID_EMAIL_OR_PASSWORD');
    });

    it('rejects a cookie-bearing request with no Origin/Referer at all', async () => {
      const res = await signInWithOrigin(undefined, true);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MISSING_OR_NULL_ORIGIN');
    });
  });
});
