/**
 * Regression test for the admin plugin's `roles` configuration.
 *
 * better-auth's admin plugin validates `adminRoles` against a `roles` map
 * that defaults to `{ admin, user }`; declaring a custom admin role name
 * (e.g. 'owner') without also declaring it in `roles` throws a
 * BetterAuthError at construction time - every other test in this repo
 * mocks getAuth() entirely, so none of them would ever catch this. This
 * test builds the real (unmocked) Better Auth instance to catch it.
 *
 * Also covers the OIDC-configured variant: `oidcConfigured` is read from
 * OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET at module scope, so that
 * test sets the env vars, resets the module registry, and dynamically
 * imports auth.js to force it to re-evaluate with genericOAuth included -
 * two real plugins together can hit a runtime validator that neither hits
 * alone.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAuth, closeAuth } from '../auth.js';

describe('getAuth construction', () => {
  afterEach(async () => {
    await closeAuth();
  });

  it('constructs the real auth instance without throwing', () => {
    expect(() => getAuth()).not.toThrow();
  });

  it('registers the expected plugins', () => {
    const auth = getAuth();
    const pluginIds = auth.options.plugins?.map((p) => p.id);
    expect(pluginIds).toEqual(['username', 'admin', 'bearer', 'plex']);
  });

  it('constructs the real auth instance with OIDC configured, alongside the default plugins', async () => {
    process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'test-client';
    process.env.OIDC_CLIENT_SECRET = 'test-secret';
    vi.resetModules();

    try {
      const { getAuth: getOidcAuth, closeAuth: closeOidcAuth } = await import('../auth.js');

      expect(() => getOidcAuth()).not.toThrow();

      const auth = getOidcAuth();
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

      expect(auth.options.account?.accountLinking).toMatchObject({
        enabled: true,
        trustedProviders: ['oidc'],
      });

      await closeOidcAuth();
    } finally {
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      vi.resetModules();
    }
  });
});
