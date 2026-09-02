/**
 * QA supplemental integration tests for the played-state increment
 * (docs/architecture/emby-played-state-sync.md; ADRs 0010/0011).
 *
 * Covers the gaps the build's own tests left open:
 *
 * 1. CR-1 fix guard - multi-page syncUser where the parser drops a row on a
 *    full page: paging must advance on the RAW row count so the tail page is
 *    still fetched and the tail rows are upserted, not stranded and pruned.
 *    There was previously no multi-page sync test at all.
 * 2. Idempotency/replay (§10) - syncing twice yields identical rows (same ids,
 *    zero prunes); re-running after an item was un-marked as played removes
 *    exactly that row and nothing else.
 * 3. Aggregate self-consistency in neverWatched.ts - totals, byMediaType,
 *    byLibrary and ageDistribution must agree with each other (count AND
 *    sizeBytes) and move together when an item flips to watched.
 * 4. stale.ts pagination boundary - played-state exclusions straddling a page
 *    boundary must keep summary_stats, pagination.total and the union of
 *    returned rows consistent, including the duplicated empty-page query path.
 * 5. Coverage honesty (ADR 0011) - an 'error' run must never count as
 *    coverage; a successful run does; any Plex server in scope forces
 *    full: false.
 *
 * Run with:
 *   pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts playedStateQa
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type {
  AuthUser,
  NeverWatchedStatsResponse,
  PlayedStateSyncProgress,
} from '@tracearr/shared';

const mockGetUsers = vi.fn();
const mockGetPlayedItems = vi.fn();

vi.mock('../../src/services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(() => ({
    serverType: 'emby',
    getUsers: mockGetUsers,
    getPlayedItems: mockGetPlayedItems,
  })),
}));

import {
  createTestEmbyServer,
  createTestPlexServer,
  createTestUser,
  createTestServerUser,
  createStoppedSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { playedStates } from '../../src/db/schema.js';
import {
  playedStateSyncService,
  buildPlayedStateCoverage,
  getPlayedStateSyncStatusResponse,
} from '../../src/services/playedStateSync.js';
import { libraryNeverWatchedRoute } from '../../src/routes/library/neverWatched.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StaleResponseShape {
  items: Array<{ id: string; title: string; category: string }>;
  summary: {
    neverWatched: { count: number; sizeBytes: number };
    stale: { count: number; sizeBytes: number };
    total: { count: number; sizeBytes: number };
  };
  pagination: { page: number; pageSize: number; total: number };
}

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

type FastifyPluginLike = Parameters<FastifyInstance['register']>[0];

/**
 * Build a route test app with a NON-caching redis stub: several tests below
 * hit the same route twice (before/after a data change) and a real
 * ioredis-mock would serve the second request from cache.
 */
async function buildApp(plugin: FastifyPluginLike): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', {
    get: async () => null,
    setex: async () => 'OK',
  } as unknown as Redis);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  await app.register(plugin);
  return app;
}

async function insertLibraryItem(opts: {
  serverId: string;
  libraryId?: string;
  ratingKey: string;
  title: string;
  mediaType: 'movie' | 'show' | 'episode';
  grandparentRatingKey?: string;
  fileSize?: number;
  addedDaysAgo?: number;
}) {
  // file_size lives on the item (read by the never-watched stats route) and on
  // a library_item_versions row (what stale.ts sums since upstream's
  // physical-file model); seed both so every route sees the same bytes.
  await db.execute(sql`
    WITH item AS (
      INSERT INTO library_items (server_id, library_id, rating_key, title, media_type, grandparent_rating_key, file_size, created_at)
      VALUES (
        ${opts.serverId}::uuid,
        ${opts.libraryId ?? 'lib-1'},
        ${opts.ratingKey},
        ${opts.title},
        ${opts.mediaType},
        ${opts.grandparentRatingKey ?? null},
        ${opts.fileSize ?? 1000},
        NOW() - INTERVAL '1 day' * ${opts.addedDaysAgo ?? 0}
      )
      RETURNING id
    )
    INSERT INTO library_item_versions (library_item_id, server_version_key, file_size)
    SELECT id, ${'v-' + opts.ratingKey}, ${opts.fileSize ?? 1000} FROM item
  `);
}

async function insertPlayedState(opts: {
  serverId: string;
  serverUserId: string;
  ratingKey: string;
  mediaType: 'movie' | 'episode';
  seriesRatingKey?: string;
  syncedAt?: Date;
}) {
  await db.execute(sql`
    INSERT INTO played_states (server_id, server_user_id, rating_key, media_type, series_rating_key, synced_at)
    VALUES (
      ${opts.serverId}::uuid,
      ${opts.serverUserId}::uuid,
      ${opts.ratingKey},
      ${opts.mediaType},
      ${opts.seriesRatingKey ?? null},
      ${opts.syncedAt ?? new Date()}
    )
  `);
}

async function getUserPlayedRows(serverUserId: string) {
  return db
    .select({
      id: playedStates.id,
      ratingKey: playedStates.ratingKey,
      syncedAt: playedStates.syncedAt,
    })
    .from(playedStates)
    .where(eq(playedStates.serverUserId, serverUserId));
}

/** Sum a numeric field over an array. */
function sumBy<T>(arr: T[], pick: (t: T) => number): number {
  return arr.reduce((acc, t) => acc + pick(t), 0);
}

/**
 * Assert the four aggregate views of a never-watched response agree with each
 * other on both count and sizeBytes (§5.2 - they all read the same CTE, so
 * any disagreement is a real defect).
 */
function expectSelfConsistent(body: NeverWatchedStatsResponse) {
  expect(sumBy(body.byMediaType, (e) => e.count)).toBe(body.totals.count);
  expect(sumBy(body.byLibrary, (e) => e.count)).toBe(body.totals.count);
  expect(sumBy(body.ageDistribution, (e) => e.count)).toBe(body.totals.count);
  expect(sumBy(body.byMediaType, (e) => e.sizeBytes)).toBe(body.totals.sizeBytes);
  expect(sumBy(body.byLibrary, (e) => e.sizeBytes)).toBe(body.totals.sizeBytes);
  expect(sumBy(body.ageDistribution, (e) => e.sizeBytes)).toBe(body.totals.sizeBytes);
}

// ---------------------------------------------------------------------------
// 1. CR-1 guard - multi-page sync with a parser-dropped row on a full page
// ---------------------------------------------------------------------------

describe('syncUser multi-page paging (CR-1 fix guard)', () => {
  it('pages on the raw row count when the parser drops a row, so the tail is synced and NOT pruned', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({
      userId: user.id,
      serverId: server.id,
      externalId: 'ext-pager',
    });

    // Seed the TAIL item from a previous run plus one genuinely-stale item.
    // Under the un-fixed behaviour (offset advanced by parsed length) the tail
    // page is never fetched, so 'tail-item' would be pruned exactly like
    // 'gone-item' - making these two rows the discriminator.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await insertPlayedState({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: 'tail-item',
      mediaType: 'movie',
      syncedAt: oneHourAgo,
    });
    await insertPlayedState({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: 'gone-item',
      mediaType: 'movie',
      syncedAt: oneHourAgo,
    });

    mockGetUsers.mockResolvedValue([{ id: 'ext-pager', username: 'pager', isAdmin: false }]);

    // Build pages dynamically from the limit the service actually requests, so
    // this test keeps exercising the multi-page path even if PAGE_SIZE changes.
    const requestedOffsets: number[] = [];
    mockGetPlayedItems.mockImplementation(
      (_externalId: string, options?: { offset?: number; limit?: number }) => {
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 100;
        requestedOffsets.push(offset);

        if (offset === 0) {
          // A FULL raw page (rawCount === limit) of which the parser dropped
          // one row (items.length === limit - 1). StartIndex pages raw rows,
          // so the next request must come in at offset === limit.
          const items = Array.from({ length: limit - 1 }, (_, i) => ({
            ratingKey: `page1-item-${i}`,
            mediaType: 'movie' as const,
          }));
          return Promise.resolve({ items, rawCount: limit, totalCount: limit + 1 });
        }
        // The tail page - only reachable when paging advanced on rawCount.
        return Promise.resolve({
          items: [{ ratingKey: 'tail-item', mediaType: 'movie' as const }],
          rawCount: 1,
          totalCount: limit + 1,
        });
      }
    );

    const result = await playedStateSyncService.syncServer(server.id);

    expect(result.status).toBe('success');
    // Two fetches: the full first page, then the tail at offset === limit
    // (raw count), NOT limit - 1 (parsed count).
    expect(requestedOffsets).toHaveLength(2);
    const firstLimit = (mockGetPlayedItems.mock.calls[0]![1] as { limit?: number } | undefined)
      ?.limit;
    expect(firstLimit).toBeGreaterThan(1);
    expect(requestedOffsets[1]).toBe(firstLimit);

    const rows = await getUserPlayedRows(su.id);
    const keys = rows.map((r) => r.ratingKey);
    // Tail survived the prune (it was re-upserted by the tail page)...
    expect(keys).toContain('tail-item');
    // ...while the genuinely-removed item was pruned.
    expect(keys).not.toContain('gone-item');
    // Full mirror: limit - 1 parsed page-1 rows + the tail row.
    expect(rows).toHaveLength(firstLimit! - 1 + 1);
    // And the tail row's synced_at was stamped by THIS run, not left stale.
    const tailRow = rows.find((r) => r.ratingKey === 'tail-item');
    expect(tailRow!.syncedAt.getTime()).toBeGreaterThan(oneHourAgo.getTime());
  }, 60000);
});

// ---------------------------------------------------------------------------
// 2. Idempotency / replay (§10)
// ---------------------------------------------------------------------------

describe('sync idempotency and replay', () => {
  it('re-running an identical sync keeps identical rows (same ids, zero prunes)', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({
      userId: user.id,
      serverId: server.id,
      externalId: 'ext-idem',
    });

    mockGetUsers.mockResolvedValue([{ id: 'ext-idem', username: 'idem', isAdmin: false }]);
    const items = [
      { ratingKey: 'movie-1', mediaType: 'movie' as const },
      { ratingKey: 'movie-2', mediaType: 'movie' as const },
      { ratingKey: 'ep-1', mediaType: 'episode' as const, seriesRatingKey: 'show-1' },
    ];
    mockGetPlayedItems.mockResolvedValue({ items, rawCount: 3, totalCount: 3 });

    const run1 = await playedStateSyncService.syncServer(server.id);
    expect(run1.status).toBe('success');
    expect(run1.itemsUpserted).toBe(3);
    const rowsAfterRun1 = await getUserPlayedRows(su.id);
    expect(rowsAfterRun1).toHaveLength(3);

    const run2 = await playedStateSyncService.syncServer(server.id);
    expect(run2.status).toBe('success');
    expect(run2.itemsUpserted).toBe(3);
    expect(run2.itemsPruned).toBe(0);

    const rowsAfterRun2 = await getUserPlayedRows(su.id);
    // Same row identities - the mirror upserts in place, it does not
    // delete-and-reinsert (replays cannot churn primary keys).
    expect(new Set(rowsAfterRun2.map((r) => r.id))).toEqual(
      new Set(rowsAfterRun1.map((r) => r.id))
    );
    expect(rowsAfterRun2.map((r) => r.ratingKey).sort()).toEqual(['ep-1', 'movie-1', 'movie-2']);
  });

  it('removes exactly the un-marked item on the next run, nothing else', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({
      userId: user.id,
      serverId: server.id,
      externalId: 'ext-unmark',
    });

    mockGetUsers.mockResolvedValue([{ id: 'ext-unmark', username: 'unmark', isAdmin: false }]);
    mockGetPlayedItems.mockResolvedValue({
      items: [
        { ratingKey: 'keep-a', mediaType: 'movie' as const },
        { ratingKey: 'unmarked', mediaType: 'movie' as const },
        { ratingKey: 'keep-b', mediaType: 'episode' as const, seriesRatingKey: 'show-keep' },
      ],
      rawCount: 3,
      totalCount: 3,
    });
    await playedStateSyncService.syncServer(server.id);
    const before = await getUserPlayedRows(su.id);
    expect(before).toHaveLength(3);
    const keptIdsBefore = before.filter((r) => r.ratingKey !== 'unmarked').map((r) => r.id);

    // The user un-marks one item on the media server: it stops appearing in
    // the IsPlayed=true response.
    mockGetPlayedItems.mockResolvedValue({
      items: [
        { ratingKey: 'keep-a', mediaType: 'movie' as const },
        { ratingKey: 'keep-b', mediaType: 'episode' as const, seriesRatingKey: 'show-keep' },
      ],
      rawCount: 2,
      totalCount: 2,
    });
    const rerun = await playedStateSyncService.syncServer(server.id);
    expect(rerun.status).toBe('success');
    expect(rerun.itemsPruned).toBe(1);

    const after = await getUserPlayedRows(su.id);
    expect(after.map((r) => r.ratingKey).sort()).toEqual(['keep-a', 'keep-b']);
    // The surviving rows are the SAME rows, not re-created ones.
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(keptIdsBefore));
  });
});

// ---------------------------------------------------------------------------
// 3. neverWatched.ts aggregate self-consistency
// ---------------------------------------------------------------------------

describe('never-watched aggregate self-consistency', () => {
  it('totals, byMediaType, byLibrary and ageDistribution agree and move together when items flip to watched', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    // Distinct sizes so any breakdown/total divergence shows up in sizeBytes
    // too; ages spread across three buckets; two libraries.
    await insertLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'nw-movie-young',
      title: 'Young Movie',
      mediaType: 'movie',
      fileSize: 1_000,
      addedDaysAgo: 5, // lt30
    });
    await insertLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'nw-movie-old',
      title: 'Old Movie',
      mediaType: 'movie',
      fileSize: 20_000,
      addedDaysAgo: 400, // gt365
    });
    await insertLibraryItem({
      serverId: server.id,
      libraryId: 'lib-shows',
      ratingKey: 'nw-show',
      title: 'Show',
      mediaType: 'show',
      fileSize: 0,
      addedDaysAgo: 100, // d90to180
    });
    // Episodes give the show a rolled-up size of 300_000 + 400_000.
    await insertLibraryItem({
      serverId: server.id,
      libraryId: 'lib-shows',
      ratingKey: 'nw-show-ep1',
      title: 'Show S01E01',
      mediaType: 'episode',
      grandparentRatingKey: 'nw-show',
      fileSize: 300_000,
    });
    await insertLibraryItem({
      serverId: server.id,
      libraryId: 'lib-shows',
      ratingKey: 'nw-show-ep2',
      title: 'Show S01E02',
      mediaType: 'episode',
      grandparentRatingKey: 'nw-show',
      fileSize: 400_000,
    });

    const app = await buildApp(libraryNeverWatchedRoute);
    try {
      const before = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(before.statusCode).toBe(200);
      const bodyBefore = before.json<NeverWatchedStatsResponse>();

      expect(bodyBefore.totals.count).toBe(3);
      expect(bodyBefore.totals.sizeBytes).toBe(1_000 + 20_000 + 700_000);
      expectSelfConsistent(bodyBefore);

      // Flip the old movie (played flag) AND the show (episode play rolled up
      // via series_rating_key) to watched.
      await insertPlayedState({
        serverId: server.id,
        serverUserId: su.id,
        ratingKey: 'nw-movie-old',
        mediaType: 'movie',
      });
      await insertPlayedState({
        serverId: server.id,
        serverUserId: su.id,
        ratingKey: 'nw-show-ep1',
        mediaType: 'episode',
        seriesRatingKey: 'nw-show',
      });

      const after = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(after.statusCode).toBe(200);
      const bodyAfter = after.json<NeverWatchedStatsResponse>();

      // Every aggregate moved together: only the young movie remains.
      expect(bodyAfter.totals.count).toBe(1);
      expect(bodyAfter.totals.sizeBytes).toBe(1_000);
      expectSelfConsistent(bodyAfter);

      const movieEntry = bodyAfter.byMediaType.find((e) => e.mediaType === 'movie');
      const showEntry = bodyAfter.byMediaType.find((e) => e.mediaType === 'show');
      expect(movieEntry?.count).toBe(1);
      expect(showEntry?.count).toBe(0);

      expect(bodyAfter.byLibrary).toHaveLength(1);
      expect(bodyAfter.byLibrary[0]?.libraryId).toBe('lib-movies');
      expect(bodyAfter.byLibrary[0]?.sizeBytes).toBe(1_000);

      const lt30 = bodyAfter.ageDistribution.find((e) => e.bucket === 'lt30');
      const gt365 = bodyAfter.ageDistribution.find((e) => e.bucket === 'gt365');
      const d90to180 = bodyAfter.ageDistribution.find((e) => e.bucket === 'd90to180');
      expect(lt30?.count).toBe(1);
      expect(gt365?.count).toBe(0);
      expect(d90to180?.count).toBe(0);

      // pctOfLibrary denominator (scope_all) must NOT shrink when items flip
      // to watched - only the numerator does.
      expect(bodyAfter.totals.libraryCount).toBe(bodyBefore.totals.libraryCount);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. stale.ts pagination boundary with straddling exclusions
// ---------------------------------------------------------------------------

describe('stale.ts pagination with exclusions straddling page boundaries', () => {
  it('keeps summary, pagination.total and the union of page rows consistent when excluded items interleave the sort order', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    // Five movies, sorted by title asc: A(never) B(excluded) C(never)
    // D(excluded) E(stale). The two excluded items sit BETWEEN the survivors,
    // so with pageSize=2 an offset computed against the unfiltered set would
    // visibly shift the pages.
    const mk = (key: string, title: string) =>
      insertLibraryItem({
        serverId: server.id,
        ratingKey: key,
        title,
        mediaType: 'movie',
        fileSize: 5_000,
      });
    await mk('st-a', 'A Never Watched');
    await mk('st-b', 'B Played No Session');
    await mk('st-c', 'C Never Watched');
    await mk('st-d', 'D Played No Session');
    await mk('st-e', 'E Old Watch');

    // B and D: provably watched (played flag) but undatable -> excluded (§5.2).
    for (const key of ['st-b', 'st-d']) {
      await insertPlayedState({
        serverId: server.id,
        serverUserId: su.id,
        ratingKey: key,
        mediaType: 'movie',
      });
    }
    // E: dated qualifying session 200 days ago -> category 'stale'.
    await createStoppedSession({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: 'st-e',
      stoppedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      durationMs: 3_600_000,
    });

    const app = await buildApp(libraryStaleRoute);
    try {
      const url = (page: number) =>
        `/stale?serverIds=${server.id}&pageSize=2&page=${page}&staleDays=90&sortBy=title&sortOrder=asc`;

      const page1 = (await app.inject({ method: 'GET', url: url(1) })).json<StaleResponseShape>();
      const page2 = (await app.inject({ method: 'GET', url: url(2) })).json<StaleResponseShape>();
      // Page 3 is past the end - the duplicated empty-page summary query path.
      const page3 = (await app.inject({ method: 'GET', url: url(3) })).json<StaleResponseShape>();

      // Survivors: A, C (never_watched) + E (stale) = 3.
      expect(page1.pagination.total).toBe(3);
      expect(page2.pagination.total).toBe(3);
      expect(page3.pagination.total).toBe(3);

      expect(page1.summary.neverWatched.count).toBe(2);
      expect(page1.summary.stale.count).toBe(1);
      expect(page1.summary.total.count).toBe(3);
      expect(page1.summary.total.sizeBytes).toBe(15_000);

      // Both query paths and every page agree on the same summary.
      expect(page2.summary).toEqual(page1.summary);
      expect(page3.summary).toEqual(page1.summary);

      // The union of returned rows equals pagination.total, in sort order,
      // with the excluded titles never surfacing on any page.
      const titles = [...page1.items, ...page2.items].map((i) => i.title);
      expect(titles).toEqual(['A Never Watched', 'C Never Watched', 'E Old Watch']);
      expect(page3.items).toHaveLength(0);

      // Category filter stays consistent under the same exclusions.
      const nwOnly = (
        await app.inject({ method: 'GET', url: `${url(1)}&category=never_watched` })
      ).json<StaleResponseShape>();
      expect(nwOnly.pagination.total).toBe(2);
      expect(nwOnly.items.map((i) => i.title)).toEqual(['A Never Watched', 'C Never Watched']);
    } finally {
      await app.close();
    }

    // Consistency seam (§2): GET /never-watched must report the same
    // never-watched count as GET /stale?category=never_watched over the same
    // data - the predicate change landed in both with the same semantics.
    const nwApp = await buildApp(libraryNeverWatchedRoute);
    try {
      const nwStats = (
        await nwApp.inject({ method: 'GET', url: `/never-watched?serverIds=${server.id}` })
      ).json<NeverWatchedStatsResponse>();
      expect(nwStats.totals.count).toBe(2);
    } finally {
      await nwApp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Coverage honesty (ADR 0011)
// ---------------------------------------------------------------------------

describe('played-state coverage honesty', () => {
  it('a successful sync yields full coverage for a lone Emby server', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    await createTestServerUser({ userId: user.id, serverId: server.id, externalId: 'ext-cov' });

    mockGetUsers.mockResolvedValue([{ id: 'ext-cov', username: 'cov', isAdmin: false }]);
    mockGetPlayedItems.mockResolvedValue({
      items: [{ ratingKey: 'cov-m', mediaType: 'movie' as const }],
      rawCount: 1,
      totalCount: 1,
    });
    await playedStateSyncService.syncServer(server.id);

    const coverage = await buildPlayedStateCoverage([server.id]);
    expect(coverage.full).toBe(true);
    expect(coverage.servers).toHaveLength(1);
    expect(coverage.servers[0]?.capability).toBe('supported');
    expect(coverage.servers[0]?.lastSyncedAt).not.toBeNull();
  });

  it("an 'error' run does NOT count as coverage (no false claim over an empty mirror)", async () => {
    const server = await createTestEmbyServer();

    // Server-level failure: getUsers rejects -> status row 'error'.
    mockGetUsers.mockRejectedValue(new Error('unreachable'));
    const result = await playedStateSyncService.syncServer(server.id);
    expect(result.status).toBe('error');

    const coverage = await buildPlayedStateCoverage([server.id]);
    expect(coverage.full).toBe(false);
    expect(coverage.servers[0]?.lastSyncedAt).toBeNull();

    // The status endpoint still reports the error honestly.
    const status = await getPlayedStateSyncStatusResponse([server.id]);
    expect(status.servers[0]?.status).toBe('error');
    expect(status.servers[0]?.error).toContain('unreachable');
  });

  it('any Plex server in scope forces full: false even when every Emby server has synced', async () => {
    const emby = await createTestEmbyServer();
    const plex = await createTestPlexServer();
    const user = await createTestUser();
    await createTestServerUser({ userId: user.id, serverId: emby.id, externalId: 'ext-mixed' });

    mockGetUsers.mockResolvedValue([{ id: 'ext-mixed', username: 'mixed', isAdmin: false }]);
    mockGetPlayedItems.mockResolvedValue({
      items: [{ ratingKey: 'mx-m', mediaType: 'movie' as const }],
      rawCount: 1,
      totalCount: 1,
    });
    await playedStateSyncService.syncServer(emby.id);

    const coverage = await buildPlayedStateCoverage([emby.id, plex.id]);
    expect(coverage.full).toBe(false);

    const embyCov = coverage.servers.find((s) => s.serverId === emby.id);
    const plexCov = coverage.servers.find((s) => s.serverId === plex.id);
    expect(embyCov?.capability).toBe('supported');
    expect(embyCov?.lastSyncedAt).not.toBeNull();
    expect(plexCov?.capability).toBe('unsupported');
    expect(plexCov?.lastSyncedAt).toBeNull();

    // Status endpoint mirrors the same reality: Plex is 'never_run'.
    const status = await getPlayedStateSyncStatusResponse([emby.id, plex.id]);
    const plexStatus = status.servers.find((s) => s.serverId === plex.id);
    expect(plexStatus?.status).toBe('never_run');
    expect(plexStatus?.capability).toBe('unsupported');
  });
});

describe('zero-resolved-users run reports failure consistently (DEF-PS-1)', () => {
  it('reports error over the progress channel and in the result, matching the status row', async () => {
    const server = await createTestEmbyServer();

    // The media server reports a user that has no matching server_users row -
    // what a played sync racing ahead of the first user sync looks like.
    mockGetUsers.mockResolvedValue([{ id: 'ext-unresolvable', username: 'ghost', isAdmin: false }]);
    mockGetPlayedItems.mockResolvedValue({ items: [], rawCount: 0, totalCount: 0 });

    const progressEvents: PlayedStateSyncProgress[] = [];
    const result = await playedStateSyncService.syncServer(server.id, (p) => {
      progressEvents.push(p);
    });

    expect(result.status).toBe('error');
    expect(result.usersTotal).toBe(0);
    expect(result.usersSkipped).toBe(1);
    // The reason has to survive into the result, not just the status row.
    expect(result.error).toMatch(/no media-server users could be resolved/i);

    // The socket must not announce completion for a run the database calls a
    // failure - any consumer other than the settings page would be misled.
    const final = progressEvents.at(-1);
    expect(final?.status).toBe('error');
    expect(final?.message).toMatch(/no media-server users could be resolved/i);

    // And coverage stays honest: an empty mirror is not coverage.
    const coverage = await buildPlayedStateCoverage([server.id]);
    expect(coverage.full).toBe(false);
    expect(coverage.servers[0]?.lastSyncedAt).toBeNull();
  });
});
