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
  getOwnerUser: vi.fn(),
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
import { getUserById, getUserByPlexAccountId, getOwnerUser } from '../../services/userService.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import { plexPlugin } from '../../lib/plexPlugin.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
    vi.mocked(getOwnerUser).mockResolvedValue(null);
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
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner-x', role: 'owner' } as never);

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
      vi.mocked(getOwnerUser).mockResolvedValue(null);
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
      vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner-x', role: 'owner' } as never);

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
    });

    it('rejects connect when a claim code is required and missing, before verifyServerAdmin', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);

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
      vi.mocked(getOwnerUser).mockResolvedValue(null);

      await expect(
        callEndpoint('plexConnect', { ...connectPayload, claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does not delete the temp token when verifyServerAdmin fails (allows retry)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);
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
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      mockGetUsers.mockResolvedValue([{ id: 'plex-local-1', isAdmin: true }]);

      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never); // no existing server
      vi.mocked(db.insert)
        .mockReturnValueOnce(makeChain([{ id: 'server-1' }]) as never)
        .mockReturnValueOnce(
          makeChain([{ id: 'user-1', username: 'newowner', role: 'owner' }]) as never
        )
        .mockReturnValueOnce(makeChain([{ id: 'plexacct-1' }]) as never);

      const { result, ctx } = await callEndpoint('plexConnect', connectPayload);

      expect(result.response.authorized).toBe(true);
      expect((result.response.user as { id: string }).id).toBe('user-1');
      expect(ctx.createSession).toHaveBeenCalledWith('user-1');
      expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('temp-abc'));
    });
  });
});
