/**
 * Library never-watched statistics route tests
 *
 * Tests GET /library/never-watched - aggregate stats over movies + shows
 * that have never been played (no qualifying session >= 2 min, shows
 * rolled up over episodes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, NeverWatchedStatsResponse } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock server filtering utilities. resolveServerIds mirrors the real implementation,
// including the ForbiddenError it throws for a non-owner's explicit unauthorized serverId.
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
import { libraryNeverWatchedRoute } from '../neverWatched.js';

/**
 * Build a test Fastify instance with mocked auth and redis
 */
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

  await app.register(libraryNeverWatchedRoute, { prefix: '/library' });

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

/** A representative raw row for the combined stats query. */
function mockRawRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        totals_count: 5,
        totals_size_bytes: '536870912000',
        totals_library_count: 20,
        totals_oldest_added_at: '2023-01-01T00:00:00.000Z',
        by_media_type: [{ mediaType: 'movie', count: 3, sizeBytes: '300000000000' }],
        by_library: [
          {
            serverId: 'server-1',
            serverName: 'Server 1',
            libraryId: 'lib-1',
            libraryName: 'lib-1',
            count: 5,
            sizeBytes: '536870912000',
          },
        ],
        age_distribution: [{ bucket: 'lt30', count: 5, sizeBytes: '536870912000' }],
        ...overrides,
      },
    ],
  };
}

describe('GET /library/never-watched', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns 200 with the full response shape, zero-filling missing buckets', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce(mockRawRow() as never);

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();

    expect(body.totals).toEqual({
      count: 5,
      sizeBytes: 536870912000,
      libraryCount: 20,
      pctOfLibrary: 25,
    });

    // byMediaType: mediaType=all default -> movie + show, show zero-filled
    expect(body.byMediaType).toHaveLength(2);
    expect(body.byMediaType).toContainEqual({
      mediaType: 'movie',
      count: 3,
      sizeBytes: 300000000000,
    });
    expect(body.byMediaType).toContainEqual({ mediaType: 'show', count: 0, sizeBytes: 0 });

    expect(body.byLibrary).toEqual([
      {
        serverId: 'server-1',
        serverName: 'Server 1',
        libraryId: 'lib-1',
        libraryName: 'lib-1',
        count: 5,
        sizeBytes: 536870912000,
      },
    ]);

    // ageDistribution: always 5 buckets, in order, zero-filled
    expect(body.ageDistribution).toHaveLength(5);
    expect(body.ageDistribution.map((b) => b.bucket)).toEqual([
      'lt30',
      'd30to90',
      'd90to180',
      'd180to365',
      'gt365',
    ]);
    expect(body.ageDistribution[0]).toEqual({ bucket: 'lt30', count: 5, sizeBytes: 536870912000 });
    expect(body.ageDistribution[1]).toEqual({ bucket: 'd30to90', count: 0, sizeBytes: 0 });
    expect(body.ageDistribution[2]).toEqual({ bucket: 'd90to180', count: 0, sizeBytes: 0 });
    expect(body.ageDistribution[3]).toEqual({ bucket: 'd180to365', count: 0, sizeBytes: 0 });
    expect(body.ageDistribution[4]).toEqual({ bucket: 'gt365', count: 0, sizeBytes: 0 });

    expect(body.oldestAddedAt).toBe('2023-01-01T00:00:00.000Z');
  });

  it('omits show from byMediaType when mediaType=movie filter applied', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce(mockRawRow() as never);

    const response = await app.inject({
      method: 'GET',
      url: '/library/never-watched?mediaType=movie',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.byMediaType).toHaveLength(1);
    expect(body.byMediaType[0]?.mediaType).toBe('movie');
  });

  it('rounds pctOfLibrary to 1 decimal', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce(
      mockRawRow({ totals_count: 1, totals_library_count: 3 }) as never
    );

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.totals.pctOfLibrary).toBe(33.3);
  });

  it('returns pctOfLibrary=0 when libraryCount is 0 (no division by zero)', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce(
      mockRawRow({
        totals_count: 0,
        totals_library_count: 0,
        totals_size_bytes: '0',
        totals_oldest_added_at: null,
        by_media_type: [],
        by_library: [],
        age_distribution: [],
      }) as never
    );

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.totals).toEqual({ count: 0, sizeBytes: 0, libraryCount: 0, pctOfLibrary: 0 });
    expect(body.oldestAddedAt).toBeNull();
  });

  it('returns an empty payload without touching the database for a non-owner with no server access', async () => {
    const viewerUser = createViewerUser([]);
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(viewerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.totals).toEqual({ count: 0, sizeBytes: 0, libraryCount: 0, pctOfLibrary: 0 });
    expect(body.byMediaType).toEqual([
      { mediaType: 'movie', count: 0, sizeBytes: 0 },
      { mediaType: 'show', count: 0, sizeBytes: 0 },
    ]);
    expect(body.byLibrary).toEqual([]);
    expect(body.ageDistribution).toHaveLength(5);
    expect(body.ageDistribution.every((b) => b.count === 0 && b.sizeBytes === 0)).toBe(true);
    expect(body.oldestAddedAt).toBeNull();

    expect(db.execute).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(redisSetex).not.toHaveBeenCalled();
  });

  it('rejects an invalid mediaType query value with 400', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    const response = await app.inject({
      method: 'GET',
      url: '/library/never-watched?mediaType=episode',
    });

    expect(response.statusCode).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed serverId with 400', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    const response = await app.inject({
      method: 'GET',
      url: '/library/never-watched?serverId=not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 403 when a non-owner requests an unauthorized serverId', async () => {
    const authorizedServer = randomUUID();
    const unauthorizedServer = randomUUID();
    const viewerUser = createViewerUser([authorizedServer]);
    app = await buildTestApp(viewerUser);

    const response = await app.inject({
      method: 'GET',
      url: `/library/never-watched?serverId=${unauthorizedServer}`,
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toContain('access');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns cached JSON without querying the database on a cache hit', async () => {
    const ownerUser = createOwnerUser();
    const cached: NeverWatchedStatsResponse = {
      totals: { count: 42, sizeBytes: 1000, libraryCount: 100, pctOfLibrary: 42 },
      byMediaType: [
        { mediaType: 'movie', count: 42, sizeBytes: 1000 },
        { mediaType: 'show', count: 0, sizeBytes: 0 },
      ],
      byLibrary: [],
      ageDistribution: [
        { bucket: 'lt30', count: 42, sizeBytes: 1000 },
        { bucket: 'd30to90', count: 0, sizeBytes: 0 },
        { bucket: 'd90to180', count: 0, sizeBytes: 0 },
        { bucket: 'd180to365', count: 0, sizeBytes: 0 },
        { bucket: 'gt365', count: 0, sizeBytes: 0 },
      ],
      oldestAddedAt: '2020-01-01T00:00:00.000Z',
    };
    const redisGet = vi.fn().mockResolvedValue(JSON.stringify(cached));
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cached);
    expect(db.execute).not.toHaveBeenCalled();
    expect(redisSetex).not.toHaveBeenCalled();
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
    await unauthApp.register(libraryNeverWatchedRoute, { prefix: '/library' });

    const response = await unauthApp.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(500); // Error thrown by mock, no error handler registered
    await unauthApp.close();
  });
});
