/**
 * Socket.io auth middleware dual-verify tests
 *
 * `resolveSocketUser` is exported from `../index.js` so the resolution logic
 * (legacy JWT -> Better Auth bearer/cookie -> mobile session lookup) can be
 * unit tested without spinning up a real Socket.io server.
 *
 * The brief's original test mocked `../../lib/auth.js`'s `auth.api.getSession`
 * directly, but `lib/auth.ts` only exports `getAuth()`/`closeAuth()` (a lazy
 * factory - see Task 4), and Task 6 already built `resolveBetterAuthUser` in
 * `lib/sessionResolver.ts` to wrap that lookup (role gating, serverIds cache,
 * fail-closed error handling). Reusing it here means the websocket middleware
 * doesn't reimplement any of that. Since the middleware also needs the raw
 * Better Auth session id (to detect mobile pairings via `mobileSessions`),
 * this mocks the sibling `resolveBetterAuthSession` export instead, which
 * returns both the resolved `AuthUser` and the session id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/sessionResolver.js', () => ({
  resolveBetterAuthSession: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { resolveBetterAuthSession } from '../../lib/sessionResolver.js';
import { db } from '../../db/client.js';
import { resolveSocketUser, checkMobileBlacklist } from '../index.js';
import type { Redis } from 'ioredis';

function mockMobileRow(row: { deviceId: string } | undefined) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as never);
}

describe('resolveSocketUser', () => {
  beforeEach(() => {
    vi.mocked(resolveBetterAuthSession).mockReset();
    mockMobileRow(undefined);
  });

  it('resolves a better auth bearer token from handshake auth', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue({
      sessionId: 'ses1',
      user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: ['s1'] },
    } as never);

    const user = await resolveSocketUser({ token: 'ba-token', headers: {} });

    expect(user).toMatchObject({ userId: 'u1', role: 'owner', serverIds: ['s1'] });
  });

  it('resolves a better auth cookie session from handshake headers', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue({
      sessionId: 'ses1',
      user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: [] },
    } as never);

    const user = await resolveSocketUser({ token: undefined, headers: { cookie: 'x=y' } });

    expect(user?.userId).toBe('u1');
  });

  it('returns null when nothing verifies', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue(null);

    const user = await resolveSocketUser({ token: 'garbage', headers: {} });

    expect(user).toBeNull();
  });

  it('marks a better auth session mobile when a mobileSessions row matches the session id', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue({
      sessionId: 'ses1',
      user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: [] },
    } as never);
    mockMobileRow({ deviceId: 'device-1' });

    const user = await resolveSocketUser({ token: 'ba-token', headers: {} });

    expect(user).toMatchObject({ userId: 'u1', mobile: true, deviceId: 'device-1' });
  });

  it('leaves a better auth session as a web session when no mobileSessions row matches', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue({
      sessionId: 'ses1',
      user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: [] },
    } as never);
    mockMobileRow(undefined);

    const user = await resolveSocketUser({ token: undefined, headers: { cookie: 'x=y' } });

    expect(user?.mobile).toBeUndefined();
    expect(user?.deviceId).toBeUndefined();
  });

  it('fails closed when the mobile session lookup throws', async () => {
    vi.mocked(resolveBetterAuthSession).mockResolvedValue({
      sessionId: 'ses1',
      user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: [] },
    } as never);
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('db down');
    });

    const user = await resolveSocketUser({ token: 'ba-token', headers: {} });

    expect(user).toBeNull();
  });
});

describe('checkMobileBlacklist', () => {
  function mockRedis(get: (key: string) => Promise<string | null>): Redis {
    return { get: vi.fn(get) } as unknown as Redis;
  }

  it('allows the connection when the device is not blacklisted', async () => {
    const redis = mockRedis(async () => null);

    const allowed = await checkMobileBlacklist(redis, 'device-1');

    expect(allowed).toBe(true);
  });

  it('denies the connection when the device is blacklisted', async () => {
    const redis = mockRedis(async () => '1');

    const allowed = await checkMobileBlacklist(redis, 'device-1');

    expect(allowed).toBe(false);
  });

  it('fails closed when the redis lookup rejects', async () => {
    const redis = mockRedis(async () => {
      throw new Error('redis down');
    });

    const allowed = await checkMobileBlacklist(redis, 'device-1');

    expect(allowed).toBe(false);
  });
});
