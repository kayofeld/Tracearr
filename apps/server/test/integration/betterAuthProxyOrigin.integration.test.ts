/**
 * Reverse-proxy origin derivation and cookie flags for the Better Auth
 * Fastify shim (integration)
 *
 * The app never sets baseURL on Better Auth, so Better Auth derives its
 * per-request trusted origin from the URL the Fastify wildcard shim builds
 * (lib/betterAuthRequest.ts). Two deployment shapes this file guards:
 *
 * 1. HTTPS reverse proxy that does NOT forward x-forwarded-proto: the shim
 *    derives http://host while the browser sends Origin: https://host, and
 *    every state-changing request (including the very first cookie-less
 *    login) fails 403 INVALID_ORIGIN. The fix trusts both schemes of the
 *    request's own host (trustedOriginsForRequest in lib/auth.ts).
 * 2. Plain-HTTP LAN with NODE_ENV=production: Better Auth decides the cookie
 *    Secure flag once at init from NODE_ENV, so browsers drop the session
 *    cookie over http. The fix pins useSecureCookies: false and has the shim
 *    append the Secure attribute per request when the derived scheme is
 *    https. Better Auth freezes its NODE_ENV read at import, so the
 *    production init-time default cannot be exercised in-process here; this
 *    file asserts the shim's per-request Secure behavior, which is what
 *    decides the attribute once useSecureCookies is pinned false.
 *
 * NODE_ENV=test makes Better Auth default advanced.disableOriginCheck to
 * true, so this file builds a disposable auth instance with the check forced
 * on (same pattern as betterAuthSecurity.integration.test.ts) and drives it
 * through the mounted Fastify wildcard route so the shim's URL construction
 * and header copying are the things under test. The instance uses the real
 * production trustedOriginsForRequest function from lib/auth.ts, so the
 * origin behavior asserted here is the deployed one, not a copy.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { username as usernamePlugin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { API_BASE_PATH } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { users, authAccounts, authSessions, authVerifications } from '../../src/db/schema.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { trustedOriginsForRequest } from '../../src/lib/auth.js';

const HOST = 'tracearr.example.com';

const originCheckAuth = betterAuth({
  basePath: '/api/v1/auth',
  secret: 'test-better-auth-secret-32-chars!!',
  trustedOrigins: trustedOriginsForRequest,
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
  session: {
    // Mirrors lib/auth.ts; also makes sign-up set two cookies
    // (session_token + session_data) so multi-cookie header integrity is
    // observable.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  emailAndPassword: { enabled: true },
  // users.username is NOT NULL, so sign-up through this instance needs the
  // same username plugin production uses.
  plugins: [usernamePlugin()],
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    handler: createBetterAuthHandler(() => originCheckAuth),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function signIn(headers: Record<string, string>, { withCookie = true } = {}) {
  return app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-in/email`,
    headers: {
      'content-type': 'application/json',
      ...(withCookie ? { cookie: 'session-probe=1' } : {}),
      host: HOST,
      ...headers,
    },
    payload: { email: 'nobody@example.com', password: 'WrongPassword!123' },
  });
}

async function signUp(headers: Record<string, string>) {
  const email = `cookie-probe-${randomUUID()}@example.com`;
  const username = `probe${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const res = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-up/email`,
    headers: { 'content-type': 'application/json', host: HOST, ...headers },
    payload: { email, password: 'CookieProbe!123', name: 'Cookie Probe', username },
  });
  return { res, email };
}

function setCookies(res: { headers: { 'set-cookie'?: string | string[] } }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function hasSecureAttribute(cookie: string): boolean {
  return /;\s*secure\s*(;|$)/i.test(cookie);
}

describe('better auth shim origin derivation behind a reverse proxy', () => {
  it('passes the origin gate for proxied HTTPS (x-forwarded-proto: https)', async () => {
    const res = await signIn({
      'x-forwarded-proto': 'https',
      origin: `https://${HOST}`,
    });
    // 401 means the request got past the origin check to the real
    // credential check; the bug manifests as 403 INVALID_ORIGIN here.
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('passes the origin gate when x-forwarded-proto carries multiple values', async () => {
    const res = await signIn({
      'x-forwarded-proto': 'https, http',
      origin: `https://${HOST}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('still rejects a cross-site origin on a proxied HTTPS request', async () => {
    const res = await signIn({
      'x-forwarded-proto': 'https',
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
  });

  it('still passes the origin gate for a plain http request with matching origin', async () => {
    const res = await signIn({
      origin: `http://${HOST}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('falls back to the request protocol when x-forwarded-proto is garbage', async () => {
    const res = await signIn({
      'x-forwarded-proto': 'evil://',
      origin: `http://${HOST}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });
});

describe('origin gate when the proxy does not forward x-forwarded-proto', () => {
  it('passes the origin gate for an https Origin with no x-forwarded-proto', async () => {
    const res = await signIn({
      origin: `https://${HOST}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('passes the gate on a cookie-less first login with no x-forwarded-proto', async () => {
    const res = await signIn({ origin: `https://${HOST}` }, { withCookie: false });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('still rejects a cross-site origin with no x-forwarded-proto', async () => {
    const res = await signIn({
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
  });

  it('passes with an http Origin while x-forwarded-proto says https', async () => {
    const res = await signIn({
      'x-forwarded-proto': 'https',
      origin: `http://${HOST}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });
});

describe('origin gate when the proxy rewrites Host but forwards x-forwarded-host', () => {
  it('derives the public host from x-forwarded-host', async () => {
    const res = await signIn({
      host: '127.0.0.1:3000',
      'x-forwarded-host': 'public.example',
      'x-forwarded-proto': 'https',
      origin: 'https://public.example',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('uses the first value of a comma-separated x-forwarded-host', async () => {
    const res = await signIn({
      host: '127.0.0.1:3000',
      'x-forwarded-host': 'public.example, internal.example',
      'x-forwarded-proto': 'https',
      origin: 'https://public.example',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('still rejects a cross-site origin when x-forwarded-host is present', async () => {
    const res = await signIn({
      host: '127.0.0.1:3000',
      'x-forwarded-host': 'public.example',
      'x-forwarded-proto': 'https',
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INVALID_ORIGIN');
  });
});

describe('cookie Secure flag follows the derived request scheme', () => {
  it('plain http sign-up sets a non-Secure cookie with no __Secure- prefix that round-trips', async () => {
    const { res, email } = await signUp({ origin: `http://${HOST}` });
    expect(res.statusCode).toBe(200);

    const cookies = setCookies(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(hasSecureAttribute(cookie)).toBe(false);
      expect(cookie.startsWith('__Secure-')).toBe(false);
    }

    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    const session = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/get-session`,
      headers: { host: HOST, cookie: cookieHeader },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()?.user?.email).toBe(email);
  });

  it('proxied https sign-up carries Secure on every Set-Cookie, kept as separate headers', async () => {
    const { res } = await signUp({
      'x-forwarded-proto': 'https',
      origin: `https://${HOST}`,
    });
    expect(res.statusCode).toBe(200);

    const cookies = setCookies(res);
    // cookieCache is enabled, so sign-up must set at least session_token and
    // session_data as SEPARATE Set-Cookie headers (joining them corrupts
    // both).
    expect(cookies.length).toBeGreaterThanOrEqual(2);
    expect(cookies.some((c) => c.includes('session_token'))).toBe(true);
    expect(cookies.some((c) => c.includes('session_data'))).toBe(true);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^[^=;,]+=/);
      expect(hasSecureAttribute(cookie)).toBe(true);
    }
  });
});

describe('trustedOriginsForRequest', () => {
  it('is safe at construction time when called with no request', () => {
    // Better Auth invokes the trustedOrigins function once while building
    // its context, before any request exists.
    expect(trustedOriginsForRequest()).toEqual([]);
    expect(trustedOriginsForRequest(undefined)).toEqual([]);
  });

  it('trusts both schemes of the request host only', () => {
    const origins = trustedOriginsForRequest(
      new Request(`http://${HOST}/api/v1/auth/sign-in/email`)
    );
    expect(origins).toEqual([`http://${HOST}`, `https://${HOST}`]);
  });

  it('keeps CORS_ORIGIN trusted from a different host', async () => {
    const previous = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = 'https://frontend.example';
    try {
      const res = await signIn({ origin: 'https://frontend.example' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_EMAIL_OR_PASSWORD');
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previous;
    }
  });
});
