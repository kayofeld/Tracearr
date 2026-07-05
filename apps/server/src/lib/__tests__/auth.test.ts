/**
 * Regression test for the admin plugin's `roles` configuration.
 *
 * better-auth's admin plugin validates `adminRoles` against a `roles` map
 * that defaults to `{ admin, user }`; declaring a custom admin role name
 * (e.g. 'owner') without also declaring it in `roles` throws a
 * BetterAuthError at construction time - every other test in this repo
 * mocks getAuth() entirely, so none of them would ever catch this. This
 * test builds the real (unmocked) Better Auth instance to catch it.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
});
