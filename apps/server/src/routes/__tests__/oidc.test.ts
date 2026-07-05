/**
 * OIDC sign-in gating tests
 *
 * Covers:
 * - GET /setup/status reports authMethods.oidc based on the OIDC_* env vars.
 * - The genericOAuth plugin (providerId 'oidc') is only added to the Better
 *   Auth plugins array when all three required env vars are set; forbidden
 *   plugins never appear.
 * - OIDC-created users still pass through the shared single-owner signup
 *   gate (fail-closed when an owner already exists).
 *
 * The `admin` plugin factory is stubbed everywhere in this file because
 * `adminPlugin({ adminRoles: ['owner'] })` throws at call time on the
 * installed better-auth version (admin roles must be a subset of the
 * `roles` map, which defaults to `['user', 'admin']`) - a pre-existing
 * issue unrelated to OIDC gating. Stubbing it is the only way to construct
 * a real (unmocked) auth instance in this suite; see task-11-report.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as BetterAuthPlugins from 'better-auth/plugins';

vi.mock('better-auth/plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof BetterAuthPlugins>();
  return {
    ...actual,
    admin: (opts: unknown) => ({ id: 'admin', type: 'stub', opts }),
  };
});

function clearOidcEnv() {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_PROVIDER_NAME;
}

describe('oidc gating', () => {
  beforeEach(() => {
    clearOidcEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearOidcEnv();
    vi.resetModules();
  });

  describe('GET /setup/status authMethods', () => {
    async function buildApp(): Promise<FastifyInstance> {
      vi.doMock('../../db/client.js', () => ({ db: { select: vi.fn() } }));
      vi.doMock('../../utils/claimCode.js', () => ({
        isClaimCodeEnabled: vi.fn().mockReturnValue(false),
      }));
      const { db } = await import('../../db/client.js');
      const emptyChain = () => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(db.select).mockImplementation(() => emptyChain() as never);

      const { setupRoutes } = await import('../setup.js');
      const app = Fastify({ logger: false });
      await app.register(setupRoutes, { prefix: '/setup' });
      return app;
    }

    it('reports oidc disabled when env is absent', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.statusCode).toBe(200);
      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: false,
        oidcProviderName: null,
      });

      await app.close();
    });

    it('reports oidc enabled with the configured provider name', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';
      process.env.OIDC_PROVIDER_NAME = 'Authentik';

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.statusCode).toBe(200);
      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: true,
        oidcProviderName: 'Authentik',
      });

      await app.close();
    });

    it('falls back to "SSO" when OIDC_PROVIDER_NAME is not set', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.json().authMethods.oidcProviderName).toBe('SSO');

      await app.close();
    });

    it('stays disabled when only some of the required env vars are set', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      // OIDC_CLIENT_SECRET intentionally omitted

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: false,
        oidcProviderName: null,
      });

      await app.close();
    });
  });

  describe('genericOAuth plugin registration', () => {
    it('is absent from the plugins array when env is not configured (byte-identical to Task 10)', async () => {
      const { getAuth, closeAuth } = await import('../../lib/auth.js');
      const auth = getAuth();
      const pluginIds = auth.options.plugins?.map((p) => p.id);

      expect(pluginIds).toEqual(['username', 'admin', 'bearer', 'plex']);
      expect(pluginIds).not.toContain('generic-oauth');
      // Forbidden plugins must never appear, regardless of OIDC config.
      for (const forbidden of ['api-key', 'sso', 'oidc-provider', 'scim']) {
        expect(pluginIds).not.toContain(forbidden);
      }

      await closeAuth();
    });

    it('registers provider id "oidc" only when all three env vars are set', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';

      const { getAuth, closeAuth } = await import('../../lib/auth.js');
      const auth = getAuth();
      const plugins = auth.options.plugins ?? [];
      const pluginIds = plugins.map((p) => p.id);

      expect(pluginIds).toEqual(['username', 'admin', 'bearer', 'plex', 'generic-oauth']);
      // Forbidden plugins must never appear, regardless of OIDC config.
      for (const forbidden of ['api-key', 'sso', 'oidc-provider', 'scim']) {
        expect(pluginIds).not.toContain(forbidden);
      }

      const genericOAuthPlugin = plugins.find((p) => p.id === 'generic-oauth') as unknown as {
        options: { config: Array<Record<string, unknown>> };
      };
      expect(genericOAuthPlugin.options.config).toEqual([
        {
          providerId: 'oidc',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
          scopes: ['openid', 'email', 'profile'],
          pkce: true,
        },
      ]);

      await closeAuth();
    });

    it('trusts the "oidc" provider for account linking', async () => {
      const { getAuth, closeAuth } = await import('../../lib/auth.js');
      const auth = getAuth();

      expect(auth.options.account?.accountLinking).toMatchObject({
        enabled: true,
        trustedProviders: ['oidc'],
      });

      await closeAuth();
    });
  });

  describe('OIDC users pass through the shared signup gate', () => {
    it('rejects user creation when signup is not allowed (existing owner), same as local sign-up', async () => {
      vi.doMock('../../lib/authGuards.js', () => ({
        assertSignupAllowed: vi
          .fn()
          .mockRejectedValue(new Error('An owner account already exists')),
        assertClaimCode: vi.fn(),
        assertUserCanLogin: vi.fn(),
      }));

      const { getAuth, closeAuth } = await import('../../lib/auth.js');
      const auth = getAuth();
      const beforeCreate = auth.options.databaseHooks?.user?.create?.before;
      expect(beforeCreate).toBeTypeOf('function');

      // The hook has no provider/source field to special-case on - an OIDC
      // sign-up funnels through the exact same `user.create.before` hook as
      // local email/password sign-up, so this failure mode covers both.
      await expect(
        beforeCreate({
          id: 'fake-id',
          createdAt: new Date(),
          updatedAt: new Date(),
          email: 'oidc-user@example.com',
          emailVerified: false,
          name: 'OIDC User',
        })
      ).rejects.toThrow('An owner account already exists');

      await closeAuth();
    });
  });
});
