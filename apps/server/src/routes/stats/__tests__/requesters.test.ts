/**
 * Ombi requester statistics route tests
 *
 * Tests GET /stats/requesters - per-Tracearr-identity Ombi request stats plus
 * the mandatory unattributed bucket (contract §6).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, RequesterStatsResponse } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock the settings service - controls the "configured" gate.
vi.mock('../../../services/settings.js', () => ({
  getSettings: vi.fn(),
}));

// Mock server filtering utilities, mirroring the real implementation.
vi.mock('../../../utils/serverFiltering.js', async () => {
  const { sql } = await import('drizzle-orm');
  const { ForbiddenError } = await import('../../../utils/errors.js');
  return {
    resolveServerIds: vi.fn((authUser, serverId, serverIds) => {
      if (serverId && authUser.role !== 'owner' && !authUser.serverIds.includes(serverId)) {
        throw new ForbiddenError('You do not have access to this server');
      }
      const requested = serverIds ?? (serverId ? [serverId] : undefined);
      if (authUser.role === 'owner') return requested ?? undefined;
      if (!requested) return authUser.serverIds;
      return requested.filter((id: string) => authUser.serverIds.includes(id));
    }),
    buildMultiServerFragment: vi.fn(() => sql``),
  };
});

import { db } from '../../../db/client.js';
import { getSettings } from '../../../services/settings.js';
import { requesterStatsRoute } from '../requesters.js';

async function buildTestApp(
  authUser: AuthUser,
  redisMock?: { get: ReturnType<typeof vi.fn>; setex: ReturnType<typeof vi.fn> }
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });

  app.decorate(
    'redis',
    (redisMock ?? {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue('OK'),
    }) as never
  );

  await app.register(requesterStatsRoute, { prefix: '/stats' });

  return app;
}

function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [],
  };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds,
  };
}

const zeroStatusCounts = { pending: 0, approved: 0, denied: 0, available: 0 };

/** A representative empty raw combined-query row (no requesters, no unattributed rows). */
function emptyRawRow() {
  return {
    rows: [
      {
        requesters: [],
        unattributed_raw: null,
        requester_count: 0,
        total_request_count: 0,
        total_never_watched_size_bytes: '0',
      },
    ],
  };
}

describe('GET /stats/requesters', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns configured:false with an empty/zeroed payload when Ombi is unconfigured, without querying the database', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null } as never);
    const ownerUser = createOwnerUser();
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    const body = response.json<RequesterStatsResponse>();
    expect(body.configured).toBe(false);
    expect(body.requesters).toEqual([]);
    expect(body.unattributed).toEqual({
      userId: null,
      username: null,
      requestCount: 0,
      movieCount: 0,
      tvCount: 0,
      statusCounts: zeroStatusCounts,
      matchedToLibraryCount: 0,
      totalSizeBytes: 0,
      neverWatchedCount: 0,
      neverWatchedSizeBytes: 0,
      watchedByRequesterCount: 0,
      firstRequestAt: null,
      lastRequestAt: null,
    });
    expect(body.totals).toEqual({
      requestCount: 0,
      requesterCount: 0,
      unattributedCount: 0,
      neverWatchedSizeBytes: 0,
    });

    expect(db.execute).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(redisSetex).not.toHaveBeenCalled();
  });

  it('always includes a zeroed unattributed bucket when no unattributed rows exist', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce(emptyRawRow() as never);

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    const body = response.json<RequesterStatsResponse>();
    expect(body.configured).toBe(true);
    expect(body.unattributed).toEqual({
      userId: null,
      username: null,
      requestCount: 0,
      movieCount: 0,
      tvCount: 0,
      statusCounts: zeroStatusCounts,
      matchedToLibraryCount: 0,
      totalSizeBytes: 0,
      neverWatchedCount: 0,
      neverWatchedSizeBytes: 0,
      watchedByRequesterCount: 0,
      firstRequestAt: null,
      lastRequestAt: null,
    });
  });

  it('maps a populated unattributed bucket and forces watchedByRequesterCount to 0', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        {
          requesters: [],
          unattributed_raw: {
            requestCount: 5,
            movieCount: 3,
            tvCount: 2,
            statusCounts: { pending: 1, approved: 2, denied: 0, available: 2 },
            matchedToLibraryCount: 4,
            totalSizeBytes: '2000000000',
            neverWatchedCount: 1,
            neverWatchedSizeBytes: '500000000',
            firstRequestAt: '2023-01-01T00:00:00.000Z',
            lastRequestAt: '2023-06-01T00:00:00.000Z',
          },
          requester_count: 0,
          total_request_count: 5,
          total_never_watched_size_bytes: '500000000',
        },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    const body = response.json<RequesterStatsResponse>();
    expect(body.unattributed).toEqual({
      userId: null,
      username: null,
      requestCount: 5,
      movieCount: 3,
      tvCount: 2,
      statusCounts: { pending: 1, approved: 2, denied: 0, available: 2 },
      matchedToLibraryCount: 4,
      totalSizeBytes: 2000000000,
      neverWatchedCount: 1,
      neverWatchedSizeBytes: 500000000,
      watchedByRequesterCount: 0,
      firstRequestAt: '2023-01-01T00:00:00.000Z',
      lastRequestAt: '2023-06-01T00:00:00.000Z',
    });
    expect(body.totals.unattributedCount).toBe(5);
  });

  it('maps attributed requesters, including watchedByRequesterCount from the row', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    const userId = randomUUID();
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        {
          requesters: [
            {
              userId,
              username: 'alice',
              requestCount: 10,
              movieCount: 7,
              tvCount: 3,
              statusCounts: { pending: 0, approved: 5, denied: 1, available: 4 },
              matchedToLibraryCount: 9,
              totalSizeBytes: '10000000000',
              neverWatchedCount: 2,
              neverWatchedSizeBytes: '1000000000',
              watchedByRequesterCount: 6,
              firstRequestAt: '2022-01-01T00:00:00.000Z',
              lastRequestAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          unattributed_raw: null,
          requester_count: 1,
          total_request_count: 10,
          total_never_watched_size_bytes: '1000000000',
        },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    const body = response.json<RequesterStatsResponse>();
    expect(body.requesters).toHaveLength(1);
    expect(body.requesters[0]).toEqual({
      userId,
      username: 'alice',
      requestCount: 10,
      movieCount: 7,
      tvCount: 3,
      statusCounts: { pending: 0, approved: 5, denied: 1, available: 4 },
      matchedToLibraryCount: 9,
      totalSizeBytes: 10000000000,
      neverWatchedCount: 2,
      neverWatchedSizeBytes: 1000000000,
      watchedByRequesterCount: 6,
      firstRequestAt: '2022-01-01T00:00:00.000Z',
      lastRequestAt: '2024-01-01T00:00:00.000Z',
    });
    expect(body.totals).toEqual({
      requestCount: 10,
      requesterCount: 1,
      unattributedCount: 0, // unattributed bucket is zeroed, not just omitted
      neverWatchedSizeBytes: 1000000000,
    });
  });

  it('varies the Redis cache key by mediaType (cross-filter collision guard)', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute).mockResolvedValue(emptyRawRow() as never);

    await app.inject({ method: 'GET', url: '/stats/requesters?mediaType=movie' });
    await app.inject({ method: 'GET', url: '/stats/requesters?mediaType=tv' });

    expect(redisGet).toHaveBeenCalledTimes(2);
    const [movieKey] = redisGet.mock.calls[0]!;
    const [tvKey] = redisGet.mock.calls[1]!;
    expect(movieKey).not.toBe(tvKey);
    expect(movieKey).toContain('movie');
    expect(tvKey).toContain('tv');
  });

  it('returns cached JSON without querying the database on a cache hit', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    const cached: RequesterStatsResponse = {
      requesters: [],
      unattributed: {
        userId: null,
        username: null,
        requestCount: 0,
        movieCount: 0,
        tvCount: 0,
        statusCounts: zeroStatusCounts,
        matchedToLibraryCount: 0,
        totalSizeBytes: 0,
        neverWatchedCount: 0,
        neverWatchedSizeBytes: 0,
        watchedByRequesterCount: 0,
        firstRequestAt: null,
        lastRequestAt: null,
      },
      totals: {
        requestCount: 0,
        requesterCount: 0,
        unattributedCount: 0,
        neverWatchedSizeBytes: 0,
      },
      configured: true,
      generatedAt: '2024-01-01T00:00:00.000Z',
    };
    const redisGet = vi.fn().mockResolvedValue(JSON.stringify(cached));
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cached);
    expect(db.execute).not.toHaveBeenCalled();
    expect(redisSetex).not.toHaveBeenCalled();
  });

  it('rejects an invalid mediaType query value with 400', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    const response = await app.inject({
      method: 'GET',
      url: '/stats/requesters?mediaType=episode',
    });

    expect(response.statusCode).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns 403 when a non-owner requests an unauthorized serverId', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const authorizedServer = randomUUID();
    const unauthorizedServer = randomUUID();
    const viewerUser = createViewerUser([authorizedServer]);
    app = await buildTestApp(viewerUser);

    const response = await app.inject({
      method: 'GET',
      url: `/stats/requesters?serverId=${unauthorizedServer}`,
    });

    expect(response.statusCode).toBe(403);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns a zeroed payload without touching the database for a non-owner with no server access', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const viewerUser = createViewerUser([]);
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(viewerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(200);
    const body = response.json<RequesterStatsResponse>();
    expect(body.configured).toBe(true);
    expect(body.requesters).toEqual([]);
    expect(body.totals.requestCount).toBe(0);

    expect(db.execute).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const unauthApp = Fastify({ logger: false });
    await unauthApp.register(sensible);
    unauthApp.decorate('authenticate', async () => {
      throw new Error('Unauthorized');
    });
    unauthApp.decorate('redis', {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue('OK'),
    } as never);
    await unauthApp.register(requesterStatsRoute, { prefix: '/stats' });

    const response = await unauthApp.inject({ method: 'GET', url: '/stats/requesters' });

    expect(response.statusCode).toBe(500); // Error thrown by mock, no error handler registered
    await unauthApp.close();
  });
});
