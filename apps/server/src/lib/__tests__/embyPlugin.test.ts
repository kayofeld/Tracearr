import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBY_LOGIN_FAILURE_REASONS, EMBY_LOGIN_PATH } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

vi.mock('../../services/mediaServer/index.js', () => ({
  EmbyClient: { getLinkedEmbyAccount: vi.fn() },
}));

import {
  decideEmbyOwnerLogin,
  resolveConfiguredEmbyServerUrl,
  resolveConfiguredEmbyServerRow,
  AmbiguousEmbyServerError,
  diagnoseEmbyLoginFailure,
  embyPlugin,
} from '../embyPlugin.js';
import { db } from '../../db/client.js';
import { EmbyClient } from '../../services/mediaServer/index.js';

const mockGetLinkedEmbyAccount = vi.mocked(EmbyClient.getLinkedEmbyAccount);

function mockEmbyServerRows(rows: { id: string; name: string; url: string; token?: string }[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

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

// SEC-02 fix: deterministic resolution must distinguish "no server
// configured" from "ambiguous" rather than picking an arbitrary row - see
// docs/architecture/emby-native-setup.md §4.1.
describe('resolveConfiguredEmbyServerUrl', () => {
  it('returns null when no emby server row exists', async () => {
    mockEmbyServerRows([]);
    await expect(resolveConfiguredEmbyServerUrl()).resolves.toBeNull();
  });

  it('returns the trimmed URL when exactly one row exists', async () => {
    mockEmbyServerRows([{ id: 's1', name: 'Emby', url: 'http://emby.local:8096/' }]);
    await expect(resolveConfiguredEmbyServerUrl()).resolves.toBe('http://emby.local:8096');
  });

  it('throws AmbiguousEmbyServerError when two rows exist - never silently picks one', async () => {
    mockEmbyServerRows([
      { id: 's1', name: 'Emby A', url: 'http://a.local' },
      { id: 's2', name: 'Emby B', url: 'http://b.local' },
    ]);
    await expect(resolveConfiguredEmbyServerUrl()).rejects.toBeInstanceOf(AmbiguousEmbyServerError);
  });
});

describe('resolveConfiguredEmbyServerRow', () => {
  it('returns the row id/name/url when exactly one row exists', async () => {
    mockEmbyServerRows([{ id: 's1', name: 'My Emby', url: 'http://emby.local:8096/' }]);
    await expect(resolveConfiguredEmbyServerRow()).resolves.toEqual({
      id: 's1',
      name: 'My Emby',
      url: 'http://emby.local:8096',
    });
  });

  // Merge-added: the row's token must reach the caller unchanged, since
  // diagnoseEmbyLoginFailure's outbound admin-API lookup depends on it - a
  // silently dropped token would make every diagnosis attempt fail closed
  // (generic message) even for the legitimate case, masking a real bug.
  it('includes the row token unchanged, so the login-failure diagnosis path gets a real admin key', async () => {
    mockEmbyServerRows([
      { id: 's1', name: 'My Emby', url: 'http://emby.local:8096/', token: 'admin-key-abc' },
    ]);
    await expect(resolveConfiguredEmbyServerRow()).resolves.toEqual({
      id: 's1',
      name: 'My Emby',
      url: 'http://emby.local:8096',
      token: 'admin-key-abc',
    });
  });
});

describe('diagnoseEmbyLoginFailure', () => {
  const SERVER = { id: 'server-1', url: 'http://emby.local:8096', token: 'admin-key' };
  const LINKED_ACCOUNT_ID = 'emby-account-linked';

  /**
   * diagnoseEmbyLoginFailure makes up to 2 sequential db.select calls
   * (owner's linked Emby account id, then the server_users cache row for
   * that id) before ever calling out to Emby. `results` supplies each
   * call's resolved rows in order; a call beyond the supplied results
   * resolves to `[]` (no more DB setup needed for that path).
   */
  function mockDbSequence(results: unknown[][]) {
    let call = 0;
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation(() => Promise.resolve(results[call++] ?? [])),
        }) as never
    );
  }

  beforeEach(() => {
    mockGetLinkedEmbyAccount.mockReset();
    vi.mocked(db.select).mockReset();
  });

  it('falls back to the generic message when no admin key is configured (no DB or Emby call)', async () => {
    const result = await diagnoseEmbyLoginFailure({ ...SERVER, token: '' }, 'demo');
    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockGetLinkedEmbyAccount).not.toHaveBeenCalled();
  });

  it('falls back to the generic message with NO outbound call when the owner has no Emby link at all', async () => {
    mockDbSequence([[]]); // owner-emby-link lookup: empty

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
    expect(mockGetLinkedEmbyAccount).not.toHaveBeenCalled();
  });

  it('falls back to the generic message with NO outbound call when there is no cached username for the linked account', async () => {
    mockDbSequence([
      [{ accountId: LINKED_ACCOUNT_ID }], // owner-emby-link lookup: link exists
      [], // server_users cache: no row yet (e.g. sync has not run)
    ]);

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS);
    expect(mockGetLinkedEmbyAccount).not.toHaveBeenCalled();
  });

  it('falls back to the generic message with NO outbound call when the submitted username does not match the linked account (owner decision F1)', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'the-real-owner' }]]);

    // Caller submits a DIFFERENT username than the one linked to the owner.
    const result = await diagnoseEmbyLoginFailure(SERVER, 'someone-else');

    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
    expect(mockGetLinkedEmbyAccount).not.toHaveBeenCalled();
  });

  it('matches the cached username case-insensitively before making the outbound call', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'Demo' }]]);
    mockGetLinkedEmbyAccount.mockResolvedValue({ isDisabled: false });

    const result = await diagnoseEmbyLoginFailure(SERVER, 'DEMO');

    expect(mockGetLinkedEmbyAccount).toHaveBeenCalledWith(
      SERVER.url,
      SERVER.token,
      LINKED_ACCOUNT_ID,
      expect.any(Number)
    );
    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);
  });

  it('reports account_disabled for the matched, linked account', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'demo' }]]);
    mockGetLinkedEmbyAccount.mockResolvedValue({ isDisabled: true });

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED);
    expect(result.message).toMatch(/disabled/i);
  });

  it('reports wrong_password and points at the stale-password scenario', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'demo' }]]);
    mockGetLinkedEmbyAccount.mockResolvedValue({ isDisabled: false });

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);
    expect(result.message).toMatch(/changed your emby password/i);
  });

  it('never emits account_locked_out - a lockout observed on Emby reads as isDisabled: false and falls back to wrong_password', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'demo' }]]);
    mockGetLinkedEmbyAccount.mockResolvedValue({ isDisabled: false });

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.code).not.toBe('account_locked_out');
    expect(result.code).toBe(EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD);
  });

  it('falls back to the generic message when the outbound lookup throws (down/invalid key/timeout), and logs a warning', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'demo' }]]);
    mockGetLinkedEmbyAccount.mockRejectedValue(new Error('ETIMEDOUT'));
    const logger = { warn: vi.fn() };

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo', logger);

    expect(result).toEqual({
      code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
      message: 'Invalid Emby username or password.',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Message only - never credentials, never the server URL.
    const [message] = logger.warn.mock.calls[0]!;
    expect(message).not.toContain(SERVER.url);
  });

  it('never echoes the password anywhere in the returned message (password never reaches this function)', async () => {
    mockDbSequence([[{ accountId: LINKED_ACCOUNT_ID }], [{ username: 'demo' }]]);
    mockGetLinkedEmbyAccount.mockResolvedValue({ isDisabled: false });

    const result = await diagnoseEmbyLoginFailure(SERVER, 'demo');

    expect(result.message).not.toContain('SECRET_PASSWORD_VALUE');
  });
});

describe('embyPlugin rate limiting', () => {
  it('registers an explicit, fixed rate-limit rule bound to the shared EMBY_LOGIN_PATH constant', () => {
    const plugin = embyPlugin();
    expect(plugin.rateLimit).toBeDefined();
    const rule = plugin.rateLimit?.[0];
    expect(rule).toBeDefined();
    // Matched against the SAME constant the endpoint is registered at
    // (security review F4) - not a second hard-coded copy of the literal,
    // which would keep passing even after a path rename.
    expect(rule?.pathMatcher(EMBY_LOGIN_PATH)).toBe(true);
    expect(rule?.pathMatcher('/sign-in/email')).toBe(false);
    // Fixed, server-side constants - never derived from the request.
    expect(typeof rule?.window).toBe('number');
    expect(typeof rule?.max).toBe('number');
    expect(rule?.window).toBeGreaterThan(0);
    expect(rule?.max).toBeGreaterThan(0);
  });
});
