/**
 * Auth Security Tests
 *
 * Tests to ensure authentication and authorization cannot be bypassed.
 * Covers: token validation and privilege escalation on the REAL production
 * decorators from plugins/auth.ts (dual-verify: Better Auth session first,
 * legacy JWT fallback). getAuth() is mocked to resolve no session, so every
 * request below exercises the legacy-JWT fallback path of dual-verify - the
 * exact edge cases (expired/tampered/wrong-secret/alg-none/garbage) that no
 * live test enumerates. Live Better Auth security coverage runs in the
 * integration suite (test/integration/betterAuthSecurity.integration.test.ts
 * and betterAuthProxyOrigin.integration.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';

vi.mock('../lib/auth.js', () => ({
  getAuth: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { getAuth } from '../lib/auth.js';
import authPlugin from '../plugins/auth.js';
import {
  generateTestToken,
  createOwnerPayload,
  createViewerPayload,
  generateExpiredToken,
  generateTamperedToken,
  generateWrongSecretToken,
} from '../test/helpers.js';

const mockRedisGet = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null);

describe('Auth Security', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie, { secret: 'test-cookie-secret' });
    app.decorate('redis', { get: mockRedisGet, set: vi.fn(), del: vi.fn() } as never);
    await app.register(authPlugin);

    // Add a protected test route that requires authentication
    app.get('/test/protected', { preHandler: [app.authenticate] }, async (request) => {
      return { user: request.user, message: 'authenticated' };
    });

    // Add an owner-only test route
    app.get('/test/owner-only', { preHandler: [app.requireOwner] }, async (request) => {
      return { user: request.user, message: 'owner access granted' };
    });

    await app.ready();
  });

  beforeEach(() => {
    // No Better Auth session resolves for any request in this file, so the
    // decorators fall through to the legacy JWT verification under test.
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    mockRedisGet.mockReset();
    mockRedisGet.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Token Validation', () => {
    it('should reject requests with no token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired token');
    });

    it('should reject requests with empty Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: '' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with malformed Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: 'not-a-bearer-token' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with Bearer but no token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: 'Bearer ' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject expired tokens', async () => {
      const expiredToken = generateExpiredToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired token');
    });

    it('should reject tampered tokens', async () => {
      const validToken = generateTestToken(app, createViewerPayload());
      const tamperedToken = generateTamperedToken(validToken);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject tokens signed with wrong secret', async () => {
      const wrongSecretToken = generateWrongSecretToken(createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${wrongSecretToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject random garbage tokens', async () => {
      const garbageTokens = [
        'not.a.jwt',
        'aaa.bbb.ccc',
        Buffer.from('garbage').toString('base64'),
        '{"userId":"hack"}',
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VySWQiOiJoYWNrIn0.',
      ];

      for (const garbage of garbageTokens) {
        const res = await app.inject({
          method: 'GET',
          url: '/test/protected',
          headers: { Authorization: `Bearer ${garbage}` },
        });

        expect(res.statusCode).toBe(401);
      }
    });

    it('should accept valid tokens', async () => {
      const validToken = generateTestToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${validToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('authenticated');
    });

    it('should preserve user data from valid token', async () => {
      const payload = createOwnerPayload({ username: 'securitytest' });
      const token = generateTestToken(app, payload);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.user.username).toBe('securitytest');
      expect(json.user.role).toBe('owner');
    });
  });

  describe('Authorization - Owner-Only Routes', () => {
    it('should reject guest users on owner-only routes', async () => {
      const guestToken = generateTestToken(app, createViewerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
        headers: { Authorization: `Bearer ${guestToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('Owner access required');
    });

    it('should accept owner users on owner-only routes', async () => {
      const ownerToken = generateTestToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('owner access granted');
    });

    it('should reject unauthenticated users on owner-only routes with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
      });

      // Should return 401, not 403 (auth before authz)
      expect(res.statusCode).toBe(401);
    });

    it('should prevent role escalation via token manipulation', async () => {
      // Create a guest token and try to tamper it to become owner
      const guestToken = generateTestToken(app, createViewerPayload());

      // Try various tampering techniques
      const tamperedTokens = [
        generateTamperedToken(guestToken), // Modify payload, keep sig
        guestToken.replace('guest', 'owner'), // Naive string replace
      ];

      for (const tampered of tamperedTokens) {
        const res = await app.inject({
          method: 'GET',
          url: '/test/owner-only',
          headers: { Authorization: `Bearer ${tampered}` },
        });

        // Should either reject as invalid (401) or as unauthorized (403)
        expect([401, 403]).toContain(res.statusCode);
      }
    });
  });

  describe('Header Security', () => {
    it('should not expose sensitive info in error responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
      });

      const body = res.json();

      // Error should not leak stack traces or internal paths
      expect(JSON.stringify(body)).not.toContain('node_modules');
      expect(JSON.stringify(body)).not.toContain('at Object');
      expect(JSON.stringify(body)).not.toContain('.ts:');
      expect(JSON.stringify(body)).not.toContain('JWT_SECRET');
    });
  });

  describe('Mobile Device Revocation', () => {
    it('rejects a blacklisted device on an authenticate route', async () => {
      mockRedisGet.mockImplementation((key: string) =>
        Promise.resolve(key.includes('device-abc') ? '1' : null)
      );

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: {
          Authorization: `Bearer ${generateTestToken(
            app,
            createOwnerPayload({ mobile: true, deviceId: 'device-abc' })
          )}`,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('revoked');
    });

    it('rejects a blacklisted device on an owner-only route', async () => {
      mockRedisGet.mockImplementation((key: string) =>
        Promise.resolve(key.includes('device-abc') ? '1' : null)
      );

      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
        headers: {
          Authorization: `Bearer ${generateTestToken(
            app,
            createOwnerPayload({ mobile: true, deviceId: 'device-abc' })
          )}`,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('revoked');
    });

    it('allows a mobile device that has not been revoked', async () => {
      mockRedisGet.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: {
          Authorization: `Bearer ${generateTestToken(
            app,
            createOwnerPayload({ mobile: true, deviceId: 'device-ok' })
          )}`,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('does not consult the blacklist for a non-mobile token', async () => {
      mockRedisGet.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${generateTestToken(app, createOwnerPayload())}` },
      });

      expect(res.statusCode).toBe(200);
      expect(mockRedisGet).not.toHaveBeenCalled();
    });
  });
});
