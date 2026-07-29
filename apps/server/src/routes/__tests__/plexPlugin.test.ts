/**
 * Plex Better Auth plugin tests
 *
 * The plugin endpoints run inside Better Auth, which normally needs a live
 * Postgres/Redis to exercise end-to-end (session creation, cookie signing).
 * None is available in this environment, so these tests invoke the plugin's
 * Better Auth endpoint handlers directly with a mocked adapter/context and
 * mock the collaborators (PlexClient, db by table identity, Redis, user
 * lookups, setSessionCookie) following the precedent in
 * src/routes/auth/__tests__/plex.test.ts. The owner-only / allowLogin /
 * first-run branching (the security-critical logic) is what is verified here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DrizzleQueryError } from 'drizzle-orm/errors';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

const { mockGetUsers } = vi.hoisted(() => ({ mockGetUsers: vi.fn() }));

vi.mock('../../services/mediaServer/index.js', () => {
  class MockPlexClient {
    getUsers = mockGetUsers;
  }
  return {
    PlexClient: Object.assign(MockPlexClient, {
      initiateOAuth: vi.fn(),
      checkOAuthPin: vi.fn(),
      getServers: vi.fn(),
      verifyServerAdmin: vi.fn(),
      AdminVerifyError: {
        CONNECTION_FAILED: 'CONNECTION_FAILED',
        NOT_ADMIN: 'NOT_ADMIN',
      },
    }),
  };
});

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
}));

vi.mock('../../services/userService.js', () => ({
  getUserById: vi.fn(),
  getUserByPlexAccountId: vi.fn(),
}));

vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(() => false),
  validateClaimCode: vi.fn(() => true),
}));

vi.mock('../../services/sync.js', () => ({ syncServer: vi.fn(() => Promise.resolve()) }));

const mockSetSessionCookie = vi.fn(
  async (
    ctx: { setCookie: (k: string, v: string) => void },
    { session }: { session: { token: string } }
  ) => {
    ctx.setCookie('better-auth.session_token', session?.token ?? 'token');
  }
);

vi.mock('better-auth/cookies', () => ({
  setSessionCookie: (ctx: unknown, session: unknown) =>
    mockSetSessionCookie(ctx as never, session as never),
}));

import { db } from '../../db/client.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import { getUserById, getUserByPlexAccountId } from '../../services/userService.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import { plexPlugin } from '../../lib/plexPlugin.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * IMP-04: plexConnect's local-accounts fetch now goes through the hardened
 * `probeFetch` (real `safeProbeJson`). CR-4/IMP-02's fix means the real
 * (non-`fetchImpl`-injected) path no longer calls the global `fetch` at all
 * - it connects directly via `node:http`/`node:https` (safeProbe.ts) so
 * `Host`/TLS `servername` can be set independent of the pinned connection
 * address, something the standard `fetch()` API does not allow. Stubbing
 * global `fetch` (`mockFetch` above) therefore has NO effect on this call;
 * a real local listener is required. Real parsing (`parseUsersResponse`/
 * `parseLocalUser`) applies to its response - unlike the old class-level
 * `PlexClient.getUsers()` mock, which handed back whatever raw object
 * literal the test wrote - so `isAdmin` is derived from `id === '1'`,
 * matching real Plex semantics, not an object literal's own `isAdmin` field.
 */
async function withLocalAccountsServer(
  accountIds: string[] = ['1']
): Promise<{ serverUri: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        MediaContainer: { Account: accountIds.map((id) => ({ id, name: `user-${id}` })) },
      })
    );
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address() as AddressInfo;
  return {
    serverUri: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

// Thenable chain mock: every builder method returns the chain, awaiting it
// resolves to the configured rows. Covers select/insert/update terminals.
function makeChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

/**
 * CR-2 fixture: the REAL shape drizzle-orm 0.45's node-postgres driver
 * produces for a unique_violation - `DrizzleQueryError`'s own `.message`
 * never contains the constraint name (drizzle-orm/errors.js); the pg
 * `DatabaseError` (carrying `.code`/`.constraint`) lives at `.cause` (see
 * utils/dbErrors.ts). A bare `Error` with the constraint name IN the message
 * is a shape drizzle never actually produces.
 */
function makeWrappedUniqueViolation(constraint: string): DrizzleQueryError {
  const cause = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  ) as Error & { code: string; constraint: string };
  cause.code = '23505';
  cause.constraint = constraint;
  return new DrizzleQueryError('insert into "user" ...', [], cause);
}

/** Same shape as makeChain, but awaiting the chain rejects instead of resolving. */
function makeRejectingChain(err: Error) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (_resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    reject ? reject(err) : Promise.reject(err);
  return chain;
}

/**
 * assertSignupAllowed() (authGuards.ts) now derives getInstanceClaimState()
 * instead of a single getOwnerUser() call: four `db.select(...).limit(1)`
 * queries issued synchronously (owner row, any users row, any auth_accounts
 * row, any servers row), in exactly that order, before the Promise.all they
 * share ever resolves. Every plexPlugin.ts call site that reaches
 * assertSignupAllowed (both plexCheckPin's first-run branch and plexConnect's
 * connect-time re-check) needs exactly these four queued in order - queue
 * them right where the OLD single getOwnerUser() mock used to be the only
 * thing standing in for this check.
 */
function pushClaimStateSelects(
  state: {
    owner?: unknown[];
    anyUser?: unknown[];
    anyAccount?: unknown[];
    anyServer?: unknown[];
  } = {}
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(makeChain(state.owner ?? []) as never)
    .mockReturnValueOnce(makeChain(state.anyUser ?? []) as never)
    .mockReturnValueOnce(makeChain(state.anyAccount ?? []) as never)
    .mockReturnValueOnce(makeChain(state.anyServer ?? []) as never);
}

function makeCtx() {
  const session = { id: 'sess-1', token: 'sess-token-1', userId: 'user-1' };
  const createSession = vi.fn(async (userId: string) => ({ ...session, userId }));
  const findUserById = vi.fn(async (userId: string) => ({
    id: userId,
    name: 'plexuser',
    email: 'plex@example.com',
  }));
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    context: { internalAdapter: { createSession, findUserById }, logger },
    createSession,
    findUserById,
  };
}

type PluginEndpoints = ReturnType<typeof plexPlugin>['endpoints'];

async function callEndpoint(
  name: keyof PluginEndpoints,
  body: Record<string, unknown>,
  ctx = makeCtx()
) {
  const endpoint = plexPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const result = (await endpoint({
    body,
    headers: new Headers(),
    context: ctx.context,
    returnHeaders: true,
  })) as { headers: Headers; response: Record<string, unknown> };
  return { result, ctx };
}

const authResult = {
  id: 'plex-tv-1',
  username: 'plexuser',
  email: 'plex@example.com',
  thumb: 'https://plex.tv/thumb.png',
  token: 'plex-token-abc',
  tokenKind: 'legacy' as const,
  refreshToken: null,
  expiresAt: null,
};

describe('plex better auth plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    vi.mocked(db.update).mockReturnValue(makeChain([]) as never);
    vi.mocked(db.insert).mockReturnValue(makeChain([]) as never);
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  it('returns authorized false while the pin is unclaimed', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(null);

    const { result } = await callEndpoint('plexCheckPin', { pinId: 'pin-1' });

    expect(result.response).toEqual({ authorized: false, message: 'PIN not yet authorized' });
  });

  it('logs in an existing owner by plex account and sets a session cookie', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 'pa-1', userId: 'owner-1', allowLogin: true }]) as never
    );
    vi.mocked(getUserById).mockResolvedValue({
      id: 'owner-1',
      role: 'owner',
      username: 'plexuser',
    } as never);

    const { result, ctx } = await callEndpoint('plexCheckPin', { pinId: 'pin-1' });

    expect(result.response.authorized).toBe(true);
    expect((result.response.user as { id: string }).id).toBe('owner-1');
    expect(ctx.createSession).toHaveBeenCalledWith('owner-1');
    expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
    expect(String(result.headers.get('set-cookie'))).toContain('better-auth');
  });

  it('rejects a non-owner plex login', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 'pa-2', userId: 'viewer-1', allowLogin: true }]) as never
    );
    vi.mocked(getUserById).mockResolvedValue({
      id: 'viewer-1',
      role: 'viewer',
      username: 'viewer',
    } as never);

    await expect(callEndpoint('plexCheckPin', { pinId: 'pin-1' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('starts server selection for a brand new first user with servers', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    // plex_accounts lookup empty, then server_users fallback empty
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([]) as never);
    vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
    pushClaimStateSelects(); // unclaimed: assertSignupAllowed() must not throw
    vi.mocked(PlexClient.getServers).mockResolvedValue([
      {
        name: 'My Plex',
        platform: 'Linux',
        productVersion: '1.40',
        clientIdentifier: 'machine-1',
        publicAddressMatches: true,
        httpsRequired: false,
        connections: [
          {
            protocol: 'http',
            uri: 'http://192.168.1.10:32400',
            local: true,
            address: '192.168.1.10',
            port: 32400,
            relay: false,
          },
        ],
      },
    ] as never);

    const { result } = await callEndpoint('plexCheckPin', { pinId: 'pin-1' });

    expect(result.response.authorized).toBe(true);
    expect(result.response.needsServerSelection).toBe(true);
    expect(result.response.tempToken).toBeTruthy();
    expect((result.response.servers as unknown[]).length).toBe(1);
    expect(mockRedis.setex).toHaveBeenCalledTimes(1);
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('rejects a new plex user when an owner already exists', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([]) as never);
    vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
    pushClaimStateSelects({ owner: [{ id: 'owner-x', role: 'owner' }] }); // owned

    await expect(callEndpoint('plexCheckPin', { pinId: 'pin-1' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('rejects a non-owner user matched via the legacy plexAccountId tier (Priority 2)', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never); // priority 1: plex_accounts empty
    vi.mocked(getUserByPlexAccountId).mockResolvedValue({
      id: 'legacy-viewer-1',
      role: 'viewer',
      username: 'legacyviewer',
    } as never);

    await expect(callEndpoint('plexCheckPin', { pinId: 'pin-legacy' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  describe('first-run (no servers) claim code enforcement', () => {
    const newAuthResult = {
      id: 'plex-tv-new',
      username: 'newuser',
      email: 'newuser@example.com',
      thumb: 'https://plex.tv/thumb3.png',
      token: 'plex-token-new',
      tokenKind: 'legacy' as const,
      refreshToken: null,
      expiresAt: null,
    };

    beforeEach(() => {
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(newAuthResult);
      // priority 1 (plex_accounts) empty, then priority 3 (server_users) empty
      vi.mocked(db.select)
        .mockReturnValueOnce(makeChain([]) as never)
        .mockReturnValueOnce(makeChain([]) as never);
      vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
      pushClaimStateSelects(); // unclaimed: assertSignupAllowed() must not throw
      vi.mocked(PlexClient.getServers).mockResolvedValue([]);
    });

    it('rejects when a claim code is required and missing', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);

      await expect(callEndpoint('plexCheckPin', { pinId: 'pin-new' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects when the claim code is required and invalid', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);

      await expect(
        callEndpoint('plexCheckPin', { pinId: 'pin-new', claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('proceeds to create the owner when the claim code is valid', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(true);
      mockRedis.del.mockResolvedValue(1);
      vi.mocked(db.insert)
        .mockReturnValueOnce(
          makeChain([{ id: 'user-new', username: 'newuser', role: 'owner' }]) as never
        )
        .mockReturnValueOnce(makeChain([{ id: 'plexacct-new' }]) as never);

      const { result, ctx } = await callEndpoint('plexCheckPin', {
        pinId: 'pin-new',
        claimCode: 'ABCD-EFGH-JKLM',
      });

      expect(result.response.authorized).toBe(true);
      expect((result.response.user as { id: string }).id).toBe('user-new');
      expect(ctx.createSession).toHaveBeenCalledWith('user-new');
      expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
    });

    // SEC-05 fix (design §7.2): this raw insert bypasses the better-auth hook
    // chain entirely, so users_single_owner is the only gate. A race loser
    // must get a clean 403, not a raw constraint-violation 500.
    it('maps a users_single_owner race loss to 403, not 500', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(true);
      vi.mocked(db.insert).mockReturnValueOnce(
        makeRejectingChain(makeWrappedUniqueViolation('users_single_owner')) as never
      );

      await expect(
        callEndpoint('plexCheckPin', { pinId: 'pin-new', claimCode: 'ABCD-EFGH-JKLM' })
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('plexConnect', () => {
    const storedTempData = {
      plexAccountId: 'plex-tv-9',
      plexUsername: 'newowner',
      plexEmail: 'newowner@example.com',
      plexThumb: 'https://plex.tv/thumb2.png',
      plexToken: 'plex-token-9',
    };
    const connectPayload = {
      tempToken: 'temp-abc',
      serverUri: 'http://192.168.1.10:32400',
      serverName: 'My Plex',
    };

    it('rejects connect when an owner already exists (re-checked at connect time)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects({ owner: [{ id: 'owner-x', role: 'owner' }] }); // owned

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
    });

    it('rejects connect when a claim code is required and missing, before verifyServerAdmin', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects(); // unclaimed

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects connect when the claim code is required and invalid, before verifyServerAdmin', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects(); // unclaimed

      await expect(
        callEndpoint('plexConnect', { ...connectPayload, claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does not delete the temp token when verifyServerAdmin fails (allows retry)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects(); // unclaimed
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: PlexClient.AdminVerifyError.CONNECTION_FAILED,
        message: 'Cannot reach Plex server',
      });

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('creates the user and server, deletes the temp token, and returns a session on success', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      mockRedis.del.mockResolvedValue(1);
      pushClaimStateSelects(); // unclaimed
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      const accountsServer = await withLocalAccountsServer(['1']);

      // Contended user insert now runs BEFORE the server select/insert (SEC-05
      // fix, design §7.2 reorder), so the insert-return order is user, then
      // server, then plexAccount - the reverse of the pre-fix order.
      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never); // no existing server
      vi.mocked(db.insert)
        .mockReturnValueOnce(
          makeChain([{ id: 'user-1', username: 'newowner', role: 'owner' }]) as never
        )
        .mockReturnValueOnce(makeChain([{ id: 'server-1' }]) as never)
        .mockReturnValueOnce(makeChain([{ id: 'plexacct-1' }]) as never);

      try {
        const { result, ctx } = await callEndpoint('plexConnect', {
          ...connectPayload,
          serverUri: accountsServer.serverUri,
        });

        expect(result.response.authorized).toBe(true);
        expect((result.response.user as { id: string }).id).toBe('user-1');
        expect(ctx.createSession).toHaveBeenCalledWith('user-1');
        expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
        expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('temp-abc'));
      } finally {
        await accountsServer.close();
      }
    });

    // IMP-04 boundary test: verifyServerAdmin is fully mocked in this suite
    // (it never touches the real safeProbeJson/global fetch here), so this
    // is the ONLY test that proves the accounts-fetch step - the previously
    // unhardened `pmsClient.getUsers()` call - independently applies the
    // SAME SSRF hardening, rather than relying on whatever the (mocked, in
    // this file) admin check happened to validate. `serverUri` targets the
    // cloud metadata address, which `assertSafeProbeUrl`'s deny list blocks
    // outright, at the accounts-fetch step's OWN literal pre-flight - the
    // real `safeProbeJson`, not a class-level mock, is what's running here.
    it('IMP-04: the local-accounts fetch is independently SSRF-hardened, not just the admin check', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects(); // unclaimed
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      // No mockAccountsFetch() call - if the accounts fetch reached the
      // network at all, mockFetch's default `{ ok: true, ... }` (no `.json`)
      // would throw a DIFFERENT error (TypeError: response.json is not a
      // function) than the SSRF rejection this test expects, so a passing
      // assertion here is proof the request never left assertSafeProbeUrl.

      await expect(
        callEndpoint('plexConnect', {
          ...connectPayload,
          serverUri: 'http://169.254.169.254:32400',
        })
      ).rejects.toMatchObject({ statusCode: 500 });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // SEC-05 fix (design §7.2): the contended user insert now runs BEFORE the
    // server select/insert, so a race loser here never touches the servers
    // table at all - no orphan row, no overwritten token - and gets a clean
    // 403 rather than a raw constraint-violation 500.
    it('maps a users_single_owner race loss to 403 and never touches the servers table', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      pushClaimStateSelects(); // unclaimed
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      const accountsServer = await withLocalAccountsServer(['1']);

      vi.mocked(db.insert).mockReturnValueOnce(
        makeRejectingChain(makeWrappedUniqueViolation('users_single_owner')) as never
      );

      try {
        await expect(
          callEndpoint('plexConnect', { ...connectPayload, serverUri: accountsServer.serverUri })
        ).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await accountsServer.close();
      }
      // Only the 4 claim-state selects ran - the "existing server" select
      // (which would run right after the user insert in the new order) never
      // fires, and only the failed user insert happened: no server
      // select/insert, no plexAccounts insert, no session, no temp-token
      // consumption.
      expect(db.select).toHaveBeenCalledTimes(4);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });
});
