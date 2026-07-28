/**
 * Library stale content route tests
 *
 * Tests GET /library/stale - never-watched/stale content pagination + summary,
 * and (new) the Ombi requester attribution field (`requestedBy`) added on top
 * of the frozen v1.7.0 shape (contract §7).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock the settings service - controls the Ombi "configured" gate.
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

import type { SQL } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { getSettings } from '../../../services/settings.js';
import { libraryStaleRoute, buildRequestedBySelectFragment } from '../stale.js';

// Renders a drizzle `sql` template's literal chunks back to a string so the
// exact emitted SQL text can be pinned without a live Postgres (mirrors
// routes/stats/__tests__/utils.test.ts's getSqlStrings helper).
function renderSqlLiteral(fragment: SQL): string {
  return (fragment as unknown as { queryChunks: unknown[] }).queryChunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        return (chunk as { value: string[] }).value.join('');
      }
      return '';
    })
    .join('');
}

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

  await app.register(libraryStaleRoute, { prefix: '/library' });

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

/** A representative raw combined-query row (item + summary columns). Defaults
 *  to the "unconfigured" attribution shape (NULL/0 literals). */
function mockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    server_id: 'server-1',
    server_name: 'Server 1',
    library_id: 'lib-1',
    library_name: 'Movies',
    title: 'Some Movie',
    media_type: 'movie',
    year: 2020,
    file_size: '1073741824',
    video_resolution: '1080p',
    added_at: '2024-01-01T00:00:00.000Z',
    last_watched: null,
    watch_count: '0',
    category: 'never_watched',
    days_stale: '10',
    request_user_id: null,
    request_username: null,
    request_ombi_username: null,
    request_ombi_alias: null,
    request_requested_at: null,
    request_distinct_requester_count: 0,
    _never_watched_count: '1',
    _stale_count: '0',
    _never_watched_bytes: '1073741824',
    _stale_bytes: '0',
    _total_stale_items: '1',
    _total_stale_bytes: '1073741824',
    ...overrides,
  };
}

describe('buildRequestedBySelectFragment - request_requested_at format (OMB-2)', () => {
  it('emits an ISO-8601 to_char() expression, not a bare ::text cast', () => {
    const sqlText = renderSqlLiteral(buildRequestedBySelectFragment(true));

    // Pins the exact expression - a bare `rb.requested_at::text` cast (the
    // OMB-2 regression) emits Postgres' native "YYYY-MM-DD HH:MI:SS.US+00"
    // format, which is not ISO-8601 per the frozen contract.
    expect(sqlText).toContain(
      `to_char(rb.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS request_requested_at`
    );
    expect(sqlText).not.toContain('rb.requested_at::text');
  });

  it('stays a NULL literal (no to_char, no join) when unconfigured', () => {
    const sqlText = renderSqlLiteral(buildRequestedBySelectFragment(false));

    expect(sqlText).toContain('NULL::text AS request_requested_at');
    expect(sqlText).not.toContain('to_char');
  });
});

describe('GET /library/stale - requestedBy attribution', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('sets requestedBy: null on every row when Ombi is unconfigured (true no-op)', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [mockRow()] } as never);

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<{ requestedBy: unknown }> }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.requestedBy).toBeNull();
  });

  it('populates requestedBy when configured and the item matched a request', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    const requesterId = randomUUID();
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        mockRow({
          request_user_id: requesterId,
          request_username: 'alice',
          request_ombi_username: 'alice_ombi',
          request_ombi_alias: 'Alice',
          request_requested_at: '2023-06-01T00:00:00.000Z',
          request_distinct_requester_count: 2,
        }),
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<{
        requestedBy: {
          userId: string | null;
          username: string | null;
          ombiUsername: string;
          ombiAlias: string | null;
          requestedAt: string;
          otherRequesterCount: number;
          source: string;
        } | null;
      }>;
    }>();
    expect(body.items[0]?.requestedBy).toEqual({
      userId: requesterId,
      username: 'alice',
      ombiUsername: 'alice_ombi',
      ombiAlias: 'Alice',
      requestedAt: '2023-06-01T00:00:00.000Z',
      otherRequesterCount: 1, // distinct count 2 minus the earliest requester itself
      source: 'ombi',
    });
  });

  it('populates requestedBy with null userId/username when the request is unattributed to a Tracearr user', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        mockRow({
          request_user_id: null,
          request_username: null,
          request_ombi_username: 'random_ombi_account',
          request_ombi_alias: null,
          request_requested_at: '2023-06-01T00:00:00.000Z',
          request_distinct_requester_count: 1,
        }),
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<{ requestedBy: Record<string, unknown> | null }> }>();
    expect(body.items[0]?.requestedBy).toEqual({
      userId: null,
      username: null,
      ombiUsername: 'random_ombi_account',
      ombiAlias: null,
      requestedAt: '2023-06-01T00:00:00.000Z',
      otherRequesterCount: 0,
      source: 'ombi',
    });
  });

  it('sets requestedBy: null when configured but nothing matched (no ombiUsername in the row)', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [mockRow()] } as never);

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<{ requestedBy: unknown }> }>();
    expect(body.items[0]?.requestedBy).toBeNull();
  });

  it('does not call getSettings on a cache hit (zero extra work when cached)', async () => {
    const cachedPayload = {
      items: [],
      summary: {
        neverWatched: { count: 0, sizeBytes: 0 },
        stale: { count: 0, sizeBytes: 0 },
        total: { count: 0, sizeBytes: 0 },
        threshold: { days: 90 },
      },
      pagination: { page: 1, pageSize: 20, total: 0 },
    };
    const redisGet = vi.fn().mockResolvedValue(JSON.stringify(cachedPayload));
    const redisSetex = vi.fn().mockResolvedValue('OK');
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cachedPayload);
    expect(getSettings).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('preserves all existing v1.7.0 item fields unchanged alongside the new requestedBy field', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        mockRow({
          id: 'item-1',
          server_id: 'srv-1',
          server_name: 'My Server',
          library_id: 'lib-42',
          library_name: 'Movies',
          title: 'The Matrix',
          media_type: 'movie',
          year: 1999,
          file_size: '9000000000',
          video_resolution: '4k',
          added_at: '2022-05-01T00:00:00.000Z',
          last_watched: '2022-06-01T00:00:00.000Z',
          watch_count: '3',
          category: 'stale',
          days_stale: '400',
        }),
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: '/library/stale' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<Record<string, unknown>> }>();
    expect(body.items[0]).toMatchObject({
      id: 'item-1',
      serverId: 'srv-1',
      serverName: 'My Server',
      libraryId: 'lib-42',
      libraryName: 'Movies',
      title: 'The Matrix',
      mediaType: 'movie',
      year: 1999,
      fileSize: 9000000000,
      resolution: '4k',
      addedAt: '2022-05-01T00:00:00.000Z',
      lastWatched: '2022-06-01T00:00:00.000Z',
      watchCount: 3,
      category: 'stale',
      daysStale: 400,
      requestedBy: null,
    });
  });
});
