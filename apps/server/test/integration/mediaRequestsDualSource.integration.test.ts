/**
 * Dual-source media_requests integration tests (Ombi + Seerr on one schema).
 *
 * Executes the REAL raw SQL of GET /stats/requesters (routes/stats/requesters.ts)
 * and GET /library/stale (routes/library/stale.ts) against a migrated Postgres
 * with media_requests rows from BOTH sources simultaneously - the one
 * combination no deployment has ever exercised (production is Ombi-only, dev is
 * Seerr-only) and the unit tests mock away entirely.
 *
 * Covers (seerr-connector design §4.4/§9, ombi contract §6/§7, ADR 0006):
 * - Cross-source identity merge: one human resolved from both sources is ONE
 *   requester row; requestCount counts both request rows.
 * - Cross-source item dedupe: the same library item requested via both sources
 *   counts once for totalSizeBytes / neverWatched*.
 * - The unattributed bucket spans sources.
 * - Configured-source scoping: a disconnected source's rows are retained in the
 *   table but invisible to both read paths, per source.
 * - /library/stale earliest-request-wins attribution across sources, and the
 *   cross-source distinct-requester count (same human via both accounts = 1).
 *
 * Settings are mocked (they gate WHICH sources the SQL scopes to - the SQL
 * itself is the test subject); db/redis-key semantics stay real via the shared
 * integration setup. Redis is a stub so every request recomputes.
 *
 * Run with:
 *   pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts mediaRequestsDualSource
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AuthUser, RequesterStatsResponse } from '@tracearr/shared';

// Mock ONLY the settings service - it controls the configured-source set the
// routes pass into the SQL. Everything else (db, schema, server filtering) is real.
vi.mock('../../src/services/settings.js', () => ({
  getSettings: vi.fn(),
}));

import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { libraryItems, mediaRequests } from '../../src/db/schema.js';
import { getSettings } from '../../src/services/settings.js';
import { requesterStatsRoute } from '../../src/routes/stats/requesters.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';

const GB = 1024 ** 3;

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

/** Settings mock helper - configure any subset of the two connectors. */
function configureSources({ ombi = false, seerr = false }: { ombi?: boolean; seerr?: boolean }) {
  vi.mocked(getSettings).mockResolvedValue({
    ombiUrl: ombi ? 'http://ombi.local' : null,
    ombiApiKey: ombi ? 'ombi-key' : null,
    seerrUrl: seerr ? 'http://seerr.local' : null,
    seerrApiKey: seerr ? 'seerr-key' : null,
  } as never);
}

async function buildApp(
  plugin: Parameters<FastifyInstance['register']>[0],
  prefix: string
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  // Redis stub: always miss, never store - each request runs the real SQL.
  app.decorate('redis', {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
  } as never);
  await app.register(plugin as never, { prefix });
  return app;
}

interface SeededWorld {
  aliceId: string;
}

/**
 * Seeds the canonical dual-source world:
 *
 * Library (one server):
 *   movieBoth  (tmdb 71100, 1 GB, never watched)  <- requested via Ombi AND Seerr, both by alice
 *   movieOmbi  (tmdb 71200, 2 GB, never watched)  <- requested via Ombi only, unattributed
 *   showSeerr  (tvdb 71300, 5 GB, never watched)  <- requested via Seerr only, unattributed
 *   movieSeen  (tmdb 71400, 3 GB, watched by alice) <- requested via Seerr only, by alice
 *
 * media_requests (NOTE: ombi and seerr rows deliberately share
 * source_request_id=71001 to prove the composite (source, media_type,
 * source_request_id) key keeps them distinct rows):
 *   R1 ombi  movie 71001 tmdb 71100 alice   requested 2024-01-01 available
 *   R2 seerr movie 71001 tmdb 71100 alice   requested 2024-02-01 approved
 *   R3 ombi  movie 71002 tmdb 71200 unattr  requested 2024-03-01 pending
 *   R4 seerr tv    71002 tvdb 71300 unattr  requested 2024-04-01 denied
 *   R5 seerr movie 71003 tmdb 71400 alice   requested 2024-05-01 available
 */
async function seedDualSourceWorld(): Promise<SeededWorld> {
  const server = await createTestServer({ type: 'jellyfin' });
  const alice = await createTestUser({ username: 'alice', role: 'member' });
  const suAlice = await createTestServerUser({ userId: alice.id, serverId: server.id });

  await db.insert(libraryItems).values([
    {
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'movie-both',
      tmdbId: 71100,
      title: 'Movie Requested Twice',
      mediaType: 'movie',
      fileSize: 1 * GB,
      createdAt: new Date('2024-01-15T00:00:00.000Z'),
    },
    {
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'movie-ombi',
      tmdbId: 71200,
      title: 'Movie Via Ombi Only',
      mediaType: 'movie',
      fileSize: 2 * GB,
      createdAt: new Date('2024-03-15T00:00:00.000Z'),
    },
    {
      serverId: server.id,
      libraryId: 'lib-shows',
      ratingKey: 'show-seerr',
      tvdbId: 71300,
      title: 'Show Via Seerr Only',
      mediaType: 'show',
      fileSize: 5 * GB,
      createdAt: new Date('2024-04-15T00:00:00.000Z'),
    },
    {
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'movie-seen',
      tmdbId: 71400,
      title: 'Movie Watched By Alice',
      mediaType: 'movie',
      fileSize: 3 * GB,
      createdAt: new Date('2024-05-15T00:00:00.000Z'),
    },
  ]);

  // Qualifying play (>= 120000 ms) of movieSeen by alice's server account.
  await createTestSession({
    serverId: server.id,
    serverUserId: suAlice.id,
    mediaType: 'movie',
    mediaTitle: 'Movie Watched By Alice',
    ratingKey: 'movie-seen',
    durationMs: 3_600_000,
    totalDurationMs: 7_200_000,
    stoppedAt: new Date(),
  });

  const syncedAt = new Date();
  await db.insert(mediaRequests).values([
    {
      source: 'ombi',
      sourceRequestId: 71001,
      mediaType: 'movie',
      title: 'Movie Requested Twice',
      tmdbId: 71100,
      status: 'available',
      requestedAt: new Date('2024-01-01T00:00:00.000Z'),
      sourceUserId: 'ombi-alice-guid',
      sourceUsername: 'alice_ombi',
      userId: alice.id,
      matchMethod: 'username',
      syncedAt,
    },
    {
      source: 'seerr',
      sourceRequestId: 71001, // same id as the ombi row - composite key must keep both
      mediaType: 'movie',
      title: null,
      tmdbId: 71100,
      status: 'approved',
      requestedAt: new Date('2024-02-01T00:00:00.000Z'),
      sourceUserId: '17',
      sourceUsername: 'alice_seerr',
      sourceExternalUserId: 'jf-alice-guid',
      userId: alice.id,
      matchMethod: 'provider',
      syncedAt,
    },
    {
      source: 'ombi',
      sourceRequestId: 71002,
      mediaType: 'movie',
      title: 'Movie Via Ombi Only',
      tmdbId: 71200,
      status: 'pending',
      requestedAt: new Date('2024-03-01T00:00:00.000Z'),
      sourceUserId: 'ombi-rando-guid',
      sourceUsername: 'ombi_rando',
      userId: null,
      matchMethod: null,
      syncedAt,
    },
    {
      source: 'seerr',
      sourceRequestId: 71002,
      mediaType: 'tv',
      title: null,
      tvdbId: 71300,
      seasons: [1, 2],
      status: 'denied',
      requestedAt: new Date('2024-04-01T00:00:00.000Z'),
      sourceUserId: '99',
      sourceUsername: 'seerr_rando',
      userId: null,
      matchMethod: null,
      syncedAt,
    },
    {
      source: 'seerr',
      sourceRequestId: 71003,
      mediaType: 'movie',
      title: null,
      tmdbId: 71400,
      status: 'available',
      requestedAt: new Date('2024-05-01T00:00:00.000Z'),
      sourceUserId: '17',
      sourceUsername: 'alice_seerr',
      sourceExternalUserId: 'jf-alice-guid',
      userId: alice.id,
      matchMethod: 'provider',
      syncedAt,
    },
  ]);

  return { aliceId: alice.id };
}

async function getRequesterStats(): Promise<RequesterStatsResponse> {
  const app = await buildApp(requesterStatsRoute, '/stats');
  const response = await app.inject({ method: 'GET', url: '/stats/requesters' });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json<RequesterStatsResponse>();
}

interface StaleItemOut {
  title: string;
  requestedBy: {
    userId: string | null;
    username: string | null;
    ombiUsername: string;
    ombiAlias: string | null;
    requestedAt: string;
    otherRequesterCount: number;
    source: 'ombi' | 'seerr';
  } | null;
}

async function getStaleItems(): Promise<StaleItemOut[]> {
  const app = await buildApp(libraryStaleRoute, '/library');
  const response = await app.inject({
    method: 'GET',
    url: '/library/stale?category=never_watched&pageSize=50',
  });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json<{ items: StaleItemOut[] }>().items;
}

describe('dual-source media_requests SQL (real Postgres)', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReset();
  });

  describe('GET /stats/requesters with rows from BOTH sources', () => {
    it('merges one human resolved from both sources into ONE row, counting both request rows but the shared item once', async () => {
      const { aliceId } = await seedDualSourceWorld();
      configureSources({ ombi: true, seerr: true });

      const body = await getRequesterStats();

      expect(body.configured).toBe(true);
      expect(body.configuredSources).toEqual({ ombi: true, seerr: true });

      // ONE row for alice despite requests from two sources (contract §6).
      expect(body.requesters).toHaveLength(1);
      const alice = body.requesters[0]!;
      expect(alice.userId).toBe(aliceId);
      expect(alice.username).toBe('alice');

      // requestCount counts BOTH rows for the co-requested movie + the seerr-only one.
      expect(alice.requestCount).toBe(3);
      expect(alice.movieCount).toBe(3);
      expect(alice.tvCount).toBe(0);
      expect(alice.statusCounts).toEqual({ pending: 0, approved: 1, denied: 0, available: 2 });

      // All three requests matched a library item...
      expect(alice.matchedToLibraryCount).toBe(3);
      // ...but the co-requested item is counted ONCE for size: 1 GB + 3 GB, not 1+1+3.
      expect(alice.totalSizeBytes).toBe(4 * GB);
      // Never watched: only movieBoth (movieSeen has a qualifying play) - once.
      expect(alice.neverWatchedCount).toBe(1);
      expect(alice.neverWatchedSizeBytes).toBe(1 * GB);
      // movieSeen was watched by alice herself.
      expect(alice.watchedByRequesterCount).toBe(1);

      // Date range spans both sources' requests.
      expect(alice.firstRequestAt).toBe('2024-01-01T00:00:00.000Z');
      expect(alice.lastRequestAt).toBe('2024-05-01T00:00:00.000Z');
    });

    it('the unattributed bucket spans sources', async () => {
      await seedDualSourceWorld();
      configureSources({ ombi: true, seerr: true });

      const body = await getRequesterStats();

      // R3 (ombi, movie) + R4 (seerr, tv) in one bucket.
      expect(body.unattributed.requestCount).toBe(2);
      expect(body.unattributed.movieCount).toBe(1);
      expect(body.unattributed.tvCount).toBe(1);
      expect(body.unattributed.statusCounts).toEqual({
        pending: 1,
        approved: 0,
        denied: 1,
        available: 0,
      });
      expect(body.unattributed.matchedToLibraryCount).toBe(2);
      expect(body.unattributed.totalSizeBytes).toBe(7 * GB); // 2 GB movie + 5 GB show
      expect(body.unattributed.neverWatchedCount).toBe(2);

      expect(body.totals.requestCount).toBe(5);
      expect(body.totals.requesterCount).toBe(1);
      expect(body.totals.unattributedCount).toBe(2);
      // Global never-watched dedupe: movieBoth 1 + movieOmbi 2 + showSeerr 5.
      expect(body.totals.neverWatchedSizeBytes).toBe(8 * GB);
    });

    it('scopes to the configured-source set: with only Ombi configured, Seerr rows are invisible but retained (design §4.4)', async () => {
      const { aliceId } = await seedDualSourceWorld();
      configureSources({ ombi: true, seerr: false });

      const body = await getRequesterStats();

      expect(body.configuredSources).toEqual({ ombi: true, seerr: false });
      // Only R1 remains visible for alice; her Seerr rows vanish.
      expect(body.requesters).toHaveLength(1);
      expect(body.requesters[0]!.userId).toBe(aliceId);
      expect(body.requesters[0]!.requestCount).toBe(1);
      expect(body.requesters[0]!.totalSizeBytes).toBe(1 * GB);
      // Only R3 in the unattributed bucket - the Seerr tv request is gone.
      expect(body.unattributed.requestCount).toBe(1);
      expect(body.unattributed.tvCount).toBe(0);
      expect(body.totals.requestCount).toBe(2);

      // Retention, not deletion: the Seerr rows are still in the table.
      const seerrRows = await db
        .select({ id: mediaRequests.id })
        .from(mediaRequests)
        .where(eq(mediaRequests.source, 'seerr'));
      expect(seerrRows).toHaveLength(3);
    });

    it('the converse scoping: with only Seerr configured, Ombi rows are invisible', async () => {
      const { aliceId } = await seedDualSourceWorld();
      configureSources({ ombi: false, seerr: true });

      const body = await getRequesterStats();

      expect(body.configuredSources).toEqual({ ombi: false, seerr: true });
      // R2 + R5 for alice.
      expect(body.requesters).toHaveLength(1);
      expect(body.requesters[0]!.userId).toBe(aliceId);
      expect(body.requesters[0]!.requestCount).toBe(2);
      // R4 only in the unattributed bucket.
      expect(body.unattributed.requestCount).toBe(1);
      expect(body.unattributed.movieCount).toBe(0);
      expect(body.unattributed.tvCount).toBe(1);
      expect(body.totals.requestCount).toBe(3);
    });
  });

  describe('GET /library/stale attribution with rows from BOTH sources', () => {
    it('earliest matching request wins across sources, and one human via two accounts counts as ONE distinct requester', async () => {
      const { aliceId } = await seedDualSourceWorld();
      configureSources({ ombi: true, seerr: true });

      const items = await getStaleItems();
      const byTitle = new Map(items.map((i) => [i.title, i]));

      // movieBoth: Ombi request (2024-01-01) predates the Seerr one (2024-02-01).
      const both = byTitle.get('Movie Requested Twice')!;
      expect(both.requestedBy).not.toBeNull();
      expect(both.requestedBy!.source).toBe('ombi');
      expect(both.requestedBy!.userId).toBe(aliceId);
      expect(both.requestedBy!.username).toBe('alice');
      expect(both.requestedBy!.ombiUsername).toBe('alice_ombi');
      expect(both.requestedBy!.requestedAt).toBe('2024-01-01T00:00:00.000Z');
      // Two request rows, ONE resolved human -> zero OTHER requesters (design §4.4).
      expect(both.requestedBy!.otherRequesterCount).toBe(0);

      // showSeerr: matched by the Seerr tv request - source must report 'seerr'.
      const show = byTitle.get('Show Via Seerr Only')!;
      expect(show.requestedBy).not.toBeNull();
      expect(show.requestedBy!.source).toBe('seerr');
      expect(show.requestedBy!.userId).toBeNull();
      expect(show.requestedBy!.ombiUsername).toBe('seerr_rando');

      // movieOmbi: unattributed Ombi requester surfaces with null identity.
      const ombiOnly = byTitle.get('Movie Via Ombi Only')!;
      expect(ombiOnly.requestedBy).not.toBeNull();
      expect(ombiOnly.requestedBy!.source).toBe('ombi');
      expect(ombiOnly.requestedBy!.userId).toBeNull();
      expect(ombiOnly.requestedBy!.ombiUsername).toBe('ombi_rando');
    });

    it('with only Seerr configured, the later Seerr request wins for the co-requested item (the Ombi row is invisible)', async () => {
      const { aliceId } = await seedDualSourceWorld();
      configureSources({ ombi: false, seerr: true });

      const items = await getStaleItems();
      const byTitle = new Map(items.map((i) => [i.title, i]));

      const both = byTitle.get('Movie Requested Twice')!;
      expect(both.requestedBy).not.toBeNull();
      expect(both.requestedBy!.source).toBe('seerr');
      expect(both.requestedBy!.userId).toBe(aliceId);
      expect(both.requestedBy!.ombiUsername).toBe('alice_seerr');
      expect(both.requestedBy!.requestedAt).toBe('2024-02-01T00:00:00.000Z');
      expect(both.requestedBy!.otherRequesterCount).toBe(0);

      // The Ombi-only movie loses its attribution entirely.
      const ombiOnly = byTitle.get('Movie Via Ombi Only')!;
      expect(ombiOnly.requestedBy).toBeNull();
    });

    it('with no connector configured, every requestedBy is null even though rows exist in the table', async () => {
      await seedDualSourceWorld();
      configureSources({ ombi: false, seerr: false });

      const items = await getStaleItems();
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.requestedBy).toBeNull();
      }
    });
  });
});
