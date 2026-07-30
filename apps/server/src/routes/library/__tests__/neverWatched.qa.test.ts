/**
 * QA supplemental tests for GET /library/never-watched
 *
 * Covers gaps left by neverWatched.test.ts:
 * - cache key varies by libraryId + mediaType + sorted serverIds (filter cache-collision guard)
 * - cache TTL uses CACHE_TTL.LIBRARY_NEVER_WATCHED
 * - corrupt cached JSON falls through to a DB compute (and re-caches)
 * - a non-owner WITH server access reaches the DB (boundary of the empty-access early return)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, NeverWatchedStatsResponse } from '@tracearr/shared';
import { CACHE_TTL, REDIS_KEYS } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock the played-state coverage helper - see neverWatched.test.ts for why.
vi.mock('../../../services/playedStateSync.js', () => ({
  buildPlayedStateCoverage: vi.fn().mockResolvedValue({ servers: [], full: false }),
}));

// Mirror the real resolveServerIds semantics (same mock as neverWatched.test.ts)
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

interface RedisMock {
  get: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
}

async function buildTestApp(authUser: AuthUser, redisMock?: RedisMock): Promise<FastifyInstance> {
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
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds };
}

function mockRawRow() {
  return {
    rows: [
      {
        totals_count: 1,
        totals_size_bytes: '1000',
        totals_library_count: 10,
        totals_oldest_added_at: '2024-01-01 00:00:00+00',
        by_media_type: [{ mediaType: 'movie', count: 1, sizeBytes: '1000' }],
        by_library: [],
        age_distribution: [{ bucket: 'gt365', count: 1, sizeBytes: '1000' }],
      },
    ],
  };
}

describe('GET /library/never-watched (QA supplemental)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('caches under a key that includes sorted serverIds, libraryId and mediaType, with the shared TTL', async () => {
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(createOwnerUser(), { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute).mockResolvedValueOnce(mockRawRow() as never);

    // Two serverIds deliberately passed in non-sorted order
    const idA = '00000000-0000-4000-8000-00000000000b';
    const idB = '00000000-0000-4000-8000-00000000000a';

    const response = await app.inject({
      method: 'GET',
      url: `/library/never-watched?serverIds=${idA}&serverIds=${idB}&libraryId=lib-9&mediaType=movie`,
    });

    expect(response.statusCode).toBe(200);
    expect(redisSetex).toHaveBeenCalledTimes(1);

    const [key, ttl, payload] = redisSetex.mock.calls[0] as [string, number, string];
    expect(key.startsWith(REDIS_KEYS.LIBRARY_NEVER_WATCHED)).toBe(true);
    // serverIds segment is sorted, so key is order-independent
    expect(key).toContain(`${idB},${idA}`);
    // filter segment prevents cache collisions across libraryId/mediaType
    expect(key).toContain('lib-9-movie');
    expect(ttl).toBe(CACHE_TTL.LIBRARY_NEVER_WATCHED);
    // cached payload is the response itself
    expect(JSON.parse(payload)).toEqual(response.json());
  });

  it('uses distinct cache keys for different mediaType filters (no cross-filter collision)', async () => {
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(createOwnerUser(), { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute)
      .mockResolvedValueOnce(mockRawRow() as never)
      .mockResolvedValueOnce(mockRawRow() as never);

    await app.inject({ method: 'GET', url: '/library/never-watched?mediaType=movie' });
    await app.inject({ method: 'GET', url: '/library/never-watched?mediaType=show' });

    expect(redisSetex).toHaveBeenCalledTimes(2);
    const keyMovie = (redisSetex.mock.calls[0] as [string])[0];
    const keyShow = (redisSetex.mock.calls[1] as [string])[0];
    expect(keyMovie).not.toBe(keyShow);
  });

  it('falls through to a DB compute when the cached value is corrupt JSON, and re-caches', async () => {
    const redisGet = vi.fn().mockResolvedValue('{not-valid-json');
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(createOwnerUser(), { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute).mockResolvedValueOnce(mockRawRow() as never);

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(redisSetex).toHaveBeenCalledTimes(1);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.totals.count).toBe(1);
  });

  it('queries the database for a non-owner with server access (empty-access early return not taken)', async () => {
    const serverId = randomUUID();
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(createViewerUser([serverId]), { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute).mockResolvedValueOnce(mockRawRow() as never);

    const response = await app.inject({ method: 'GET', url: '/library/never-watched' });

    expect(response.statusCode).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const body = response.json<NeverWatchedStatsResponse>();
    expect(body.totals.count).toBe(1);
    // Cache key scoped to the viewer's resolved server list, not 'all'
    const [key] = redisSetex.mock.calls[0] as [string];
    expect(key).toContain(serverId);
    expect(key).not.toContain(':all:');
  });
});
