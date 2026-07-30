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

// Mock the played-state coverage helper (docs/architecture/emby-played-state-sync.md
// §5.3/§7.3) - it runs its own db.select/leftJoin query, out of scope for this
// file's execute-only db mock. Coverage computation itself is covered by
// test/integration/playedStatePredicate.integration.test.ts against a real DB.
vi.mock('../../../services/playedStateSync.js', () => ({
  buildPlayedStateCoverage: vi.fn().mockResolvedValue({ servers: [], full: false }),
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
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client.js';
import { getSettings } from '../../../services/settings.js';
import {
  libraryStaleRoute,
  buildRequestedBySelectFragment,
  buildRequestedOnlyFilterFragment,
} from '../stale.js';

const pgDialect = new PgDialect();
/** Compiles a drizzle `sql` fragment to its final SQL text (placeholders for
 *  params), mirroring jobs/__tests__/cleanupMobileTokens.test.ts's pattern -
 *  handles nested fragments (unlike the literal-chunk-only renderSqlLiteral
 *  below), so it can pin text produced by nested sql`` calls (e.g. the
 *  requestedOnly EXISTS clause built from buildRequesterMatchCondition). */
function renderCompiledSql(fragment: SQL): string {
  return pgDialect.sqlToQuery(fragment).sql;
}

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
    request_source_username: null,
    request_source_alias: null,
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
          request_source_username: 'alice_ombi',
          request_source_alias: 'Alice',
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
          request_source_username: 'random_ombi_account',
          request_source_alias: null,
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

describe('buildRequestedOnlyFilterFragment', () => {
  it('is an empty fragment when requestedOnly=false, regardless of configuration', () => {
    expect(renderCompiledSql(buildRequestedOnlyFilterFragment(false, true, ['ombi'], 'si'))).toBe(
      ''
    );
    expect(renderCompiledSql(buildRequestedOnlyFilterFragment(false, false, [], 'si'))).toBe('');
  });

  it('is an empty fragment when requestedOnly=true but no connector is configured', () => {
    expect(renderCompiledSql(buildRequestedOnlyFilterFragment(true, false, [], 'si'))).toBe('');
  });

  it('emits an EXISTS semi-join scoped to the given item alias and sources when active', () => {
    const text = renderCompiledSql(buildRequestedOnlyFilterFragment(true, true, ['ombi'], 'si'));
    expect(text).toContain('EXISTS (');
    expect(text).toContain('media_requests ro');
    // Item-side columns reference the passed-in alias, not the paginated_items
    // ('pi') alias used elsewhere in the route.
    expect(text).toContain('si.media_type');
    expect(text).toContain('si.imdb_id');
    expect(text).not.toContain('pi.media_type');
  });

  it('scopes the source filter to whichever connectors are configured', () => {
    const ombiOnly = renderCompiledSql(
      buildRequestedOnlyFilterFragment(true, true, ['ombi'], 'si')
    );
    const both = renderCompiledSql(
      buildRequestedOnlyFilterFragment(true, true, ['ombi', 'seerr'], 'si')
    );
    expect(ombiOnly.toLowerCase()).toContain('ro.source in');
    expect(both.toLowerCase()).toContain('ro.source in');
    // Two distinct param placeholders for two sources vs one for a single source.
    expect(both).not.toBe(ombiOnly);
  });
});

describe('GET /library/stale - requestedOnly query param', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('omitting the flag leaves the executed SQL byte-identical to explicit requestedOnly=false', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();

    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValue({ rows: [mockRow()] } as never);
    await app.inject({ method: 'GET', url: '/library/stale' });
    const omittedSql = renderCompiledSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
    await app.close();
    vi.mocked(db.execute).mockClear();

    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute).mockResolvedValue({ rows: [mockRow()] } as never);
    await app.inject({ method: 'GET', url: '/library/stale?requestedOnly=false' });
    const explicitFalseSql = renderCompiledSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);

    expect(explicitFalseSql).toBe(omittedSql);
    // Confirms the default path carries no trace of the requestedOnly filter
    // specifically (no added cost/shape change for the common unfiltered
    // case). Not a blanket "no EXISTS anywhere" check: the played-state
    // predicate (docs/architecture/emby-played-state-sync.md §5.2) always
    // adds its own unconditional `EXISTS (... played_states ...)` clause,
    // independent of requestedOnly.
    expect(omittedSql).not.toContain('media_requests ro');
  });

  it('returns only rows with a requester and total reflects the filtered set, composed with mediaTypes + category', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    // The DB layer is mocked, so this asserts what the route ASKS the DB for
    // (the compiled SQL text), not live Postgres execution (no local Postgres
    // available - see integration-test note below). The mock row's summary
    // fields simulate "only 1 of the underlying rows matched" - the mapping
    // logic simply relays whatever the (real, in production) filtered CTE
    // returns, so pagination.total is always the same query's count.
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        mockRow({
          request_source_username: 'alice_ombi',
          request_requested_at: '2023-06-01T00:00:00.000Z',
          _total_stale_items: '1',
        }),
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/library/stale?requestedOnly=true&category=never_watched&mediaTypes=movie&mediaTypes=show',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<{ requestedBy: unknown }>;
      pagination: { total: number };
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.requestedBy).not.toBeNull();
    expect(body.pagination.total).toBe(1);

    const sqlText = renderCompiledSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
    // All three predicates present...
    expect(sqlText).toContain('EXISTS (');
    expect(sqlText).toContain("category = 'never_watched'");
    expect(sqlText.toLowerCase()).toContain('li.media_type in');
    // ...and the requestedOnly EXISTS is applied INSIDE filtered_items, i.e.
    // strictly before summary_stats and paginated_items derive from it - so
    // the count query and the page query see the exact same filtered rows.
    // NOTE: "paginated_items" as a bare substring also appears earlier inside
    // a pre-existing English SQL comment on item_watch_stats
    // ("Carried through to stale_items/paginated_items purely for..."), so the
    // CTE-definition keywords ("AS (") are pinned specifically to find the
    // real CTE boundaries, not that comment. Likewise "EXISTS (" alone is
    // ambiguous now that the played-state predicate (§5.2) adds its own
    // unconditional EXISTS earlier in stale_items - "media_requests ro" pins
    // specifically the requestedOnly semi-join under test.
    const filteredItemsIdx = sqlText.indexOf('filtered_items AS (');
    const existsIdx = sqlText.indexOf('media_requests ro');
    const summaryStatsIdx = sqlText.indexOf('summary_stats AS (');
    const paginatedItemsCteIdx = sqlText.indexOf('paginated_items AS (');
    expect(filteredItemsIdx).toBeGreaterThan(-1);
    expect(existsIdx).toBeGreaterThan(filteredItemsIdx);
    expect(existsIdx).toBeLessThan(summaryStatsIdx);
    expect(existsIdx).toBeLessThan(paginatedItemsCteIdx);
  });

  it('applies requestedOnly to the empty-page fallback summary query too (page beyond the filtered set)', async () => {
    // When the requested page has no rows (e.g. requestedOnly narrowed the set
    // and the page offset lands past it), the route re-queries just the
    // summary. That second query must apply the exact same requestedOnly
    // predicate - otherwise an out-of-range page would report a summary/total
    // computed WITHOUT the filter.
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as never) // combined query: empty page
      .mockResolvedValueOnce({
        rows: [
          {
            never_watched_count: '0',
            stale_count: '0',
            never_watched_bytes: '0',
            stale_bytes: '0',
            total_stale_items: '0',
            total_stale_bytes: '0',
          },
        ],
      } as never); // fallback summary-only query

    const response = await app.inject({
      method: 'GET',
      url: '/library/stale?requestedOnly=true&page=5',
    });

    expect(response.statusCode).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(2);
    const fallbackSql = renderCompiledSql(vi.mocked(db.execute).mock.calls[1]![0] as SQL);
    expect(fallbackSql).toContain('EXISTS (');
    expect(fallbackSql).toContain('media_requests ro');
    expect(fallbackSql).toContain('si.imdb_id');
  });

  it('returns an honest empty result set (no DB call) when requestedOnly=true and no connector is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: null,
      ombiApiKey: null,
      seerrUrl: null,
      seerrApiKey: null,
    } as never);
    const ownerUser = createOwnerUser();
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, {
      get: vi.fn().mockResolvedValue(null),
      setex: redisSetex,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/library/stale?requestedOnly=true',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: unknown[];
      summary: { total: { count: number } };
      pagination: { total: number };
    }>();
    expect(body.items).toEqual([]);
    expect(body.summary.total.count).toBe(0);
    expect(body.pagination.total).toBe(0);
    // Zero-cost short-circuit: never touches the database.
    expect(db.execute).not.toHaveBeenCalled();
    // Still cached, like every other response shape.
    expect(redisSetex).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct cache key for requestedOnly=true vs the default (no cross-contamination)', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'secret',
    } as never);
    const ownerUser = createOwnerUser();
    const redisGet = vi.fn().mockResolvedValue(null);
    const redisSetex = vi.fn().mockResolvedValue('OK');
    app = await buildTestApp(ownerUser, { get: redisGet, setex: redisSetex });
    vi.mocked(db.execute).mockResolvedValue({ rows: [mockRow()] } as never);

    await app.inject({ method: 'GET', url: '/library/stale' });
    await app.inject({ method: 'GET', url: '/library/stale?requestedOnly=true' });

    const keys = redisGet.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  // NOTE: the assertions above pin the compiled SQL TEXT the route sends to
  // Postgres (via a mocked db.execute + PgDialect.sqlToQuery), and the route's
  // response-mapping logic given a canned row set. There is no local Postgres
  // in this environment, so these are NOT integration tests against a real
  // database - the actual query has not been executed against real data.
  // An integration test (real DB, real media_requests/library_items rows,
  // asserting requestedOnly=true genuinely restricts the returned+counted
  // rows) should be written and run in an environment with Postgres before
  // this ships to production.
});
