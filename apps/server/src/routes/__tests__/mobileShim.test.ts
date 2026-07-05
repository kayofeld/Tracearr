/**
 * Mobile Better Auth shim tests (Task 13)
 *
 * Verifies the pair/refresh endpoints and the requireMobile decorator run on
 * Better Auth sessions while keeping the frozen wire contract
 * (mobileContract.test.ts) intact:
 * - pairing creates a Better Auth backed session (betterAuthSessionId stored,
 *   both tokens are the BA session token)
 * - the pair accessToken authenticates requireMobile endpoints as a bearer
 * - refresh keeps its response shape for BA pairings without rotating
 * - legacy mobile JWTs still authenticate requireMobile
 * - revoking a device deletes the linked Better Auth session
 *
 * Like the sibling routes tests, this runs against a mocked db and Redis
 * (no live Postgres/Redis in this suite); getAuth() is stubbed the same way
 * authDecorators.test.ts stubs it. The real end-to-end pair flow with a live
 * createSession belongs to the live-DB integration gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';

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

vi.mock('../../lib/auth.js', () => ({
  getAuth: vi.fn(),
}));

import { db } from '../../db/client.js';
import { getAuth } from '../../lib/auth.js';
import { mobileSessions, mobileTokens, users, servers, authSessions } from '../../db/schema.js';
import { hashSha256 } from '../../utils/hash.js';
import authPlugin from '../../plugins/auth.js';
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

const OWNER_ID = randomUUID();
const SERVER_ID = randomUUID();
const BA_SESSION_ID = 'ba-session-id-1';
const BA_TOKEN = 'ba-session-token-1';
const WEB_TOKEN = 'ba-web-token-1';
const WEB_SESSION_ID = 'ba-web-session-id-1';
const DEVICE_ID = 'device-1';

const revokedTokens = new Set<string>();
const createSession = vi.fn();
const deleteSession = vi.fn();
const getSession = vi.fn();

function stubGetAuth() {
  revokedTokens.clear();
  createSession.mockReset().mockResolvedValue({
    id: BA_SESSION_ID,
    token: BA_TOKEN,
    userId: OWNER_ID,
  });
  deleteSession.mockReset().mockImplementation(async (token: string) => {
    revokedTokens.add(token);
  });
  getSession.mockReset().mockImplementation(async ({ headers }: { headers: Headers }) => {
    const auth = headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || revokedTokens.has(token)) return null;
    if (token === BA_TOKEN) {
      return {
        user: { id: OWNER_ID, name: 'owner', username: 'owner', role: 'owner' },
        session: { id: BA_SESSION_ID },
      };
    }
    if (token === WEB_TOKEN) {
      return {
        user: { id: OWNER_ID, name: 'owner', username: 'owner', role: 'owner' },
        session: { id: WEB_SESSION_ID },
      };
    }
    return null;
  });
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession },
    $context: Promise.resolve({ internalAdapter: { createSession, deleteSession } }),
  } as unknown as ReturnType<typeof getAuth>);
}

// Routes db.select()/tx.select() to canned rows by table identity so the
// tests don't depend on query call order.
interface Chain {
  where: () => Chain;
  for: () => Chain;
  limit: () => Promise<unknown[]>;
  then: (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise<unknown>;
}

function chainFor(rows: unknown[]): Chain {
  const chain: Chain = {
    where: () => chain,
    for: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function routeSelects(rowsByTable: Map<unknown, unknown[]>) {
  vi.mocked(db.select).mockImplementation((() => ({
    from: (table: unknown) => chainFor(rowsByTable.get(table) ?? []),
  })) as never);
}

function createMockToken() {
  return {
    id: randomUUID(),
    tokenHash: 'tokenhash123',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    usedAt: null,
    createdBy: OWNER_ID,
    createdAt: new Date(),
  };
}

function baMobileSessionRow(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    userId: OWNER_ID,
    refreshTokenHash: hashSha256(BA_TOKEN),
    previousRefreshTokenHash: null,
    betterAuthSessionId: BA_SESSION_ID,
    deviceName: 'Test Phone',
    deviceId: DEVICE_ID,
    platform: 'ios' as const,
    expoPushToken: null,
    deviceSecret: null,
    lastSeenAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(sensible);
  app.decorate('redis', mockRedis as never);
  await app.register(authPlugin);
  await app.register(mobileRoutes, { prefix: '/mobile' });
  return app;
}

describe('mobile better auth shim', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    vi.mocked(db.transaction).mockReset();
    mockRedis.get.mockReset().mockResolvedValue(null);
    mockRedis.set.mockReset().mockResolvedValue('OK');
    mockRedis.setex.mockReset().mockResolvedValue('OK');
    mockRedis.del.mockReset().mockResolvedValue(1);
    mockRedis.eval.mockReset().mockResolvedValue(1);
    mockRedis.ttl.mockReset().mockResolvedValue(0);
    stubGetAuth();

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as never);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('pairing creates a better auth backed session', async () => {
    app = await buildTestApp();

    routeSelects(new Map([[mobileSessions, []]]));

    const insertedValues: Record<string, unknown>[] = [];
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const txRows = new Map<unknown, unknown[]>([
        [mobileTokens, [createMockToken()]],
        [users, [{ id: OWNER_ID, username: 'owner', role: 'owner' }]],
        [servers, [{ id: SERVER_ID, name: 'MyServer', type: 'plex' }]],
      ]);
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockImplementation(() => ({
          from: (table: unknown) => chainFor(txRows.get(table) ?? []),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation(async (v: Record<string, unknown>) => {
            insertedValues.push(v);
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return callback(tx as never);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/pair',
      payload: {
        token: 'trr_mob_validtokenvalue12345678901234567890',
        deviceName: 'Test Phone',
        deviceId: DEVICE_ID,
        platform: 'ios',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBe(BA_TOKEN);
    expect(body.refreshToken).toBe(BA_TOKEN);
    expect(createSession).toHaveBeenCalledWith(OWNER_ID);

    const sessionInsert = insertedValues.find((v) => v.deviceId === DEVICE_ID);
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert?.betterAuthSessionId).toBe(BA_SESSION_ID);
    expect(sessionInsert?.refreshTokenHash).toBe(hashSha256(BA_TOKEN));
  });

  it('the pair accessToken authenticates requireMobile endpoints', async () => {
    app = await buildTestApp();

    routeSelects(
      new Map<unknown, unknown[]>([
        [servers, [{ id: SERVER_ID }]],
        [mobileSessions, [baMobileSessionRow()]],
        [
          users,
          [
            {
              id: OWNER_ID,
              username: 'owner',
              name: null,
              thumbnail: null,
              email: null,
              role: 'owner',
            },
          ],
        ],
      ])
    );

    const res = await app.inject({
      method: 'GET',
      url: '/mobile/me',
      headers: { authorization: `Bearer ${BA_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('owner');
  });

  it('denies a better auth bearer with no mobile session row', async () => {
    app = await buildTestApp();

    routeSelects(
      new Map<unknown, unknown[]>([
        [servers, [{ id: SERVER_ID }]],
        [mobileSessions, []],
      ])
    );

    const res = await app.inject({
      method: 'GET',
      url: '/mobile/me',
      headers: { authorization: `Bearer ${BA_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('denies a blacklisted better auth device', async () => {
    app = await buildTestApp();

    routeSelects(
      new Map<unknown, unknown[]>([
        [servers, [{ id: SERVER_ID }]],
        [mobileSessions, [baMobileSessionRow()]],
      ])
    );
    mockRedis.get.mockImplementation(async (key: string) =>
      key.includes('blacklist') ? '1' : null
    );

    const res = await app.inject({
      method: 'GET',
      url: '/mobile/me',
      headers: { authorization: `Bearer ${BA_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Session has been revoked');
  });

  it('refresh returns the same shape for a better auth pairing', async () => {
    app = await buildTestApp();

    mockRedis.get.mockResolvedValue(JSON.stringify({ userId: OWNER_ID, deviceId: DEVICE_ID }));
    routeSelects(
      new Map<unknown, unknown[]>([
        [users, [{ id: OWNER_ID, username: 'owner', role: 'owner' }]],
        [mobileSessions, [baMobileSessionRow()]],
      ])
    );

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/refresh',
      payload: { refreshToken: BA_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(body.accessToken).toBe(BA_TOKEN);
    expect(body.refreshToken).toBe(BA_TOKEN);
    expect(getSession).toHaveBeenCalled();
  });

  it('refresh rejects a revoked better auth token', async () => {
    app = await buildTestApp();

    revokedTokens.add(BA_TOKEN);
    mockRedis.get.mockResolvedValue(JSON.stringify({ userId: OWNER_ID, deviceId: DEVICE_ID }));
    routeSelects(
      new Map<unknown, unknown[]>([
        [users, [{ id: OWNER_ID, username: 'owner', role: 'owner' }]],
        [mobileSessions, [baMobileSessionRow()]],
      ])
    );

    const res = await app.inject({
      method: 'POST',
      url: '/mobile/refresh',
      payload: { refreshToken: BA_TOKEN },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Invalid or expired refresh token');
  });

  it('a legacy JWT still authenticates requireMobile', async () => {
    app = await buildTestApp();

    routeSelects(
      new Map<unknown, unknown[]>([
        [
          users,
          [
            {
              id: OWNER_ID,
              username: 'owner',
              name: null,
              thumbnail: null,
              email: null,
              role: 'owner',
            },
          ],
        ],
      ])
    );

    const legacyToken = app.jwt.sign({
      userId: OWNER_ID,
      username: 'owner',
      role: 'owner',
      serverIds: [SERVER_ID],
      mobile: true,
      deviceId: 'legacy-device',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/mobile/me',
      headers: { authorization: `Bearer ${legacyToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('owner');
  });

  it('revoking the device kills the better auth session too', async () => {
    app = await buildTestApp();

    const sessionRow = baMobileSessionRow();
    routeSelects(
      new Map<unknown, unknown[]>([
        [servers, [{ id: SERVER_ID }]],
        [mobileSessions, [sessionRow]],
        [authSessions, [{ token: BA_TOKEN }]],
      ])
    );

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/mobile/sessions/${sessionRow.id}`,
      headers: { authorization: `Bearer ${WEB_TOKEN}` },
    });

    expect(revokeRes.statusCode).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith(BA_TOKEN);

    // The revoked bearer no longer resolves a Better Auth session
    routeSelects(
      new Map<unknown, unknown[]>([
        [servers, [{ id: SERVER_ID }]],
        [mobileSessions, [sessionRow]],
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: '/mobile/me',
      headers: { authorization: `Bearer ${BA_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
