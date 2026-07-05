/**
 * Mobile pair/refresh contract freeze
 *
 * Records the CURRENT byte-shape of POST /mobile/pair and POST /mobile/refresh
 * (routes/mobile.ts) as fixtures. Task 13 rewrites the internals of these
 * endpoints on top of Better Auth; these tests MUST NOT be edited by that work
 * because they are the safety net proving the wire contract held.
 *
 * Fields consumed by the mobile app (do not remove or rename without a
 * coordinated mobile release):
 * - pair response: accessToken, refreshToken (apps/mobile/src/lib/authStateStore.ts)
 *   server.id, server.name, server.type (authStateStore.ts pairServer -> StoredServer)
 *   user.userId, user.username, user.role (authStateStore.ts pairServer -> UserInfo)
 *   apps/mobile/src/lib/api.ts also runtime-checks accessToken, refreshToken,
 *   server.id, and user.userId before trusting the response.
 * - refresh response: accessToken, refreshToken (apps/mobile/src/lib/api.ts performTokenRefresh)
 *
 * Setup mirrors src/routes/__tests__/mobile.test.ts (mocked db/redis/jwt,
 * local buildTestApp) since routes/__tests__ tests run against a mocked
 * database, not a real one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../services/termination.js', () => ({
  terminateSession: vi.fn(),
}));

vi.mock('../../websocket/index.js', () => ({
  disconnectMobileDevice: vi.fn(),
  disconnectAllMobileDevices: vi.fn(),
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

// getAuth is stubbed because this harness mocks the db out from under Better
// Auth (its drizzle adapter cannot run against the vi.fn() db above), the same
// way the db itself is mocked. Deterministic values only; nothing here is
// under test. The real pair flow with a live createSession is exercised in the
// live-DB integration gate. The frozen contract assertions below are unchanged.
vi.mock('../../lib/auth.js', () => ({
  getAuth: vi.fn(),
}));

import { db } from '../../db/client.js';
import { getAuth } from '../../lib/auth.js';
import { mobileRoutes } from '../mobile.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(),
  ttl: vi.fn(),
  multi: vi.fn(() => ({
    del: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    setex: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 1],
      [null, 'OK'],
    ]),
  })),
};

const mockJwt = {
  sign: vi.fn(),
  verify: vi.fn(),
};

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', mockRedis as never);
  app.decorate('jwt', mockJwt as never);
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  app.decorate('authenticate', async () => {});
  app.decorate('requireMobile', async (request: unknown) => {
    (request as { user: AuthUser }).user = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [randomUUID()],
      mobile: true,
      deviceId: 'device-123',
    };
  });
  await app.register(mobileRoutes, { prefix: '/mobile' });
  return app;
}

function createMockToken(overrides?: Partial<{ expiresAt: Date; usedAt: Date | null }>) {
  return {
    id: randomUUID(),
    tokenHash: 'tokenhash123',
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    usedAt: overrides?.usedAt ?? null,
    createdBy: randomUUID(),
    createdAt: new Date(),
  };
}

function createMockSession() {
  return {
    id: randomUUID(),
    deviceName: 'iPhone 15',
    deviceId: 'device-123',
    platform: 'ios' as const,
    refreshTokenHash: 'hash123',
    previousRefreshTokenHash: null,
    expoPushToken: null,
    deviceSecret: null,
    userId: randomUUID(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
  };
}

describe('mobile contract freeze', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.transaction).mockReset();
    mockRedis.get.mockReset();
    mockRedis.setex.mockReset();
    mockRedis.del.mockReset();
    mockRedis.eval.mockReset();
    mockRedis.ttl.mockReset();
    mockJwt.sign.mockReset();
    vi.mocked(getAuth).mockReset();
    vi.mocked(getAuth).mockReturnValue({
      api: {
        getSession: vi.fn().mockResolvedValue(null),
      },
      $context: Promise.resolve({
        internalAdapter: {
          createSession: vi
            .fn()
            .mockResolvedValue({ id: 'ba-session-id', token: 'ba-session-token' }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
      }),
    } as unknown as ReturnType<typeof getAuth>);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  const validPairPayload = {
    token: 'trr_mob_validtokenvalue12345678901234567890',
    deviceName: 'Test Phone',
    deviceId: 'device-1',
    platform: 'ios',
  };

  it('pair response has exactly the frozen shape', async () => {
    app = await buildTestApp();

    mockRedis.eval.mockResolvedValue(1);

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return { from: vi.fn().mockResolvedValue([{ count: 0 }]) } as never;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never;
    });

    const mockOwner = { id: randomUUID(), username: 'owner', role: 'owner' };
    const mockServerId = randomUUID();
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      let txSelectCallCount = 0;
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockImplementation(() => {
          txSelectCallCount++;
          if (txSelectCallCount === 3) {
            return {
              from: vi
                .fn()
                .mockResolvedValue([{ id: mockServerId, name: 'MyServer', type: 'plex' }]),
            };
          }
          return {
            from: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => ({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([createMockToken()]),
                }),
                limit: vi.fn().mockResolvedValue([mockOwner]),
              })),
            })),
          };
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return callback(tx as never);
    });

    mockJwt.sign.mockReturnValue('mock.jwt.token');
    mockRedis.setex.mockResolvedValue('OK');

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/pair',
      payload: validPairPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'refreshToken', 'server', 'user']);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(Object.keys(body.server).sort()).toEqual(['id', 'name', 'type']);
    expect(typeof body.server.id).toBe('string');
    expect(typeof body.server.name).toBe('string');
    expect(typeof body.server.type).toBe('string');
    expect(Object.keys(body.user).sort()).toEqual(['role', 'userId', 'username']);
    expect(typeof body.user.userId).toBe('string');
    expect(typeof body.user.username).toBe('string');
    expect(body.user.role).toBe('owner');
  });

  it('refresh response has exactly the frozen shape', async () => {
    app = await buildTestApp();

    mockRedis.eval.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ userId: randomUUID(), deviceId: 'device-123' })
    );

    const mockUser = { id: randomUUID(), username: 'owner', role: 'owner' };
    const mockSession = createMockSession();

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockUser]),
            }),
          }),
        } as never;
      } else if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockSession]),
            }),
          }),
        } as never;
      }
      return { from: vi.fn().mockResolvedValue([{ id: randomUUID() }]) } as never;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as never);

    mockJwt.sign.mockReturnValue('new.jwt.token');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.setex.mockResolvedValue('OK');

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/refresh',
      payload: { refreshToken: 'valid-refresh-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
  });

  it('pair invalid-token response keeps its status code and shape', async () => {
    app = await buildTestApp();
    mockRedis.eval.mockResolvedValue(1);

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return { from: vi.fn().mockResolvedValue([{ count: 0 }]) } as never;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never;
    });

    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })),
      };
      return callback(tx as never);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/pair',
      payload: { token: 'trr_mob_invalid', deviceName: 'x', deviceId: 'd', platform: 'ios' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(body.message).toBe('Invalid mobile token');
  });

  it('pair rate limit response keeps its status code, headers, and shape', async () => {
    app = await buildTestApp();
    mockRedis.eval.mockResolvedValue(6);
    mockRedis.ttl.mockResolvedValue(300);

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/pair',
      payload: validPairPayload,
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('300');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(body.message).toBe('Too many pairing attempts. Please try again later.');
  });

  it('pair expired-token response keeps its status code and shape', async () => {
    app = await buildTestApp();
    mockRedis.eval.mockResolvedValue(1);

    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }) as never
    );

    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => ({
              for: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([createMockToken({ expiresAt: new Date(Date.now() - 1000) })]),
              }),
            })),
          })),
        })),
      };
      return callback(tx as never);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/pair',
      payload: validPairPayload,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(body.message).toBe('This pairing token has expired');
  });

  it('refresh rate limit response keeps its status code', async () => {
    app = await buildTestApp();
    mockRedis.eval.mockResolvedValue(31);
    mockRedis.ttl.mockResolvedValue(600);

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/refresh',
      payload: { refreshToken: 'any-token' },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
  });

  it('refresh invalid-token response keeps its status code and shape', async () => {
    app = await buildTestApp();
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/refresh',
      payload: { refreshToken: 'invalid-token' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(body.message).toBe('Invalid or expired refresh token');
  });
});
