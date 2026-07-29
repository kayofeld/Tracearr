import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBY_LOGIN_FAILURE_REASONS } from '@tracearr/shared';

vi.mock('../../services/mediaServer/index.js', () => ({
  EmbyClient: { diagnoseLoginFailure: vi.fn() },
}));

import { EmbyClient } from '../../services/mediaServer/index.js';
import { decideEmbyOwnerLogin, diagnoseEmbyLoginFailure, embyPlugin } from '../embyPlugin.js';

const mockDiagnoseLoginFailure = vi.mocked(EmbyClient.diagnoseLoginFailure);

const OWNER = 'owner-1';
const EMBY = 'emby-user-9';

describe('decideEmbyOwnerLogin', () => {
  it('denies a non-admin Emby account', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: false,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: false,
    });
    expect(d).toEqual({ allow: false, reason: expect.stringMatching(/administrator/i) });
  });

  it('links (TOFU) when admin, no link yet, and the owner has no Emby binding', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: false,
    });
    expect(d).toEqual({ allow: true, needsLink: true });
  });

  it('allows a returning admin whose Emby account is already linked to the owner', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: { userId: OWNER },
      ownerHasEmbyLink: true,
    });
    expect(d).toEqual({ allow: true, needsLink: false });
  });

  it('denies an admin whose Emby account is linked to a DIFFERENT user', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: { userId: 'someone-else' },
      ownerHasEmbyLink: false,
    });
    expect(d).toMatchObject({ allow: false });
  });

  it('denies rebinding a second Emby admin once the owner is already bound (no hijack)', () => {
    // A different Emby admin tries to log in; the owner is already bound to
    // another Emby identity. Must NOT rebind/allow.
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: 'a-second-admin',
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: true,
    });
    expect(d).toMatchObject({ allow: false });
  });
});

describe('diagnoseEmbyLoginFailure', () => {
  const SERVER = { url: 'http://emby.local:8096', token: 'admin-key' };

  beforeEach(() => {
    mockDiagnoseLoginFailure.mockReset();
  });

  it('falls back to the generic message when no admin key is configured', async () => {
    const result = await diagnoseEmbyLoginFailure({ url: SERVER.url, token: '' }, 'demo');
    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
    // Must never call out to Emby with an empty/missing key.
    expect(mockDiagnoseLoginFailure).not.toHaveBeenCalled();
  });

  it('falls back to the generic message when the lookup throws (down/invalid key/timeout)', async () => {
    mockDiagnoseLoginFailure.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
  });

  it('reports user_not_found', async () => {
    mockDiagnoseLoginFailure.mockResolvedValue(EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'nobody');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND);
    expect(result.message).toMatch(/no emby account exists/i);
  });

  it('reports account_disabled', async () => {
    mockDiagnoseLoginFailure.mockResolvedValue(EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED);
    expect(result.message).toMatch(/disabled/i);
  });

  it('reports account_locked_out', async () => {
    mockDiagnoseLoginFailure.mockResolvedValue(EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT);
    expect(result.message).toMatch(/locked/i);
  });

  it('reports wrong_password and points at the stale-password scenario', async () => {
    mockDiagnoseLoginFailure.mockResolvedValue(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);
    expect(result.message).toMatch(/changed your emby password/i);
  });

  it('never echoes the password anywhere in the returned message', async () => {
    mockDiagnoseLoginFailure.mockResolvedValue(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.message).not.toContain('SECRET_PASSWORD_VALUE');
    // The diagnosis call itself receives only the username, never a password.
    expect(mockDiagnoseLoginFailure.mock.calls[0]).toEqual([
      SERVER.url,
      SERVER.token,
      'demo',
      expect.any(Number),
    ]);
  });
});

describe('embyPlugin rate limiting', () => {
  it('registers an explicit, fixed rate-limit rule scoped to /emby/login', () => {
    const plugin = embyPlugin();
    expect(plugin.rateLimit).toBeDefined();
    const rule = plugin.rateLimit?.[0];
    expect(rule).toBeDefined();
    expect(rule?.pathMatcher('/emby/login')).toBe(true);
    expect(rule?.pathMatcher('/sign-in/email')).toBe(false);
    // Fixed, server-side constants - never derived from the request.
    expect(typeof rule?.window).toBe('number');
    expect(typeof rule?.max).toBe('number');
    expect(rule?.window).toBeGreaterThan(0);
    expect(rule?.max).toBeGreaterThan(0);
  });
});
