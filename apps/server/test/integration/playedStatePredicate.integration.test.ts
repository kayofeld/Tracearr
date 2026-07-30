/**
 * Played-state predicate integration tests (docs/architecture/emby-played-state-sync.md
 * §5.1/§5.2). Exercises the real SQL in neverWatched.ts and stale.ts against a real
 * database - both routes add `AND NOT EXISTS (... played_states ...)` to their
 * never-watched definition, and stale.ts additionally excludes provably-watched-but-
 * undatable items from BOTH of its query paths (the main combined query and the
 * duplicated empty-page summary query).
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- playedStatePredicate
 */
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser, NeverWatchedStatsResponse } from '@tracearr/shared';
import {
  createTestEmbyServer,
  createTestPlexServer,
  createTestUser,
  createTestServerUser,
  createStoppedSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryNeverWatchedRoute } from '../../src/routes/library/neverWatched.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';

// Route file re-declares its response shapes locally (StaleResponse isn't
// exported), so this test's expectations are typed loosely against the wire
// JSON rather than importing an interface that doesn't exist as a named export.
interface StaleResponseShape {
  items: Array<{ id: string; category: string }>;
  summary: {
    neverWatched: { count: number; sizeBytes: number };
    stale: { count: number; sizeBytes: number };
    total: { count: number; sizeBytes: number };
  };
  pagination: { page: number; pageSize: number; total: number };
  playedStateCoverage?: {
    servers: Array<{ serverId: string; capability: string; lastSyncedAt: string | null }>;
    full: boolean;
  };
}

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

async function buildApp(plugin: FastifyPluginLike): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  await app.register(plugin);
  return app;
}

// Minimal shape to keep the helper above untyped against fastify internals.
type FastifyPluginLike = Parameters<FastifyInstance['register']>[0];

async function insertLibraryItem(opts: {
  serverId: string;
  libraryId?: string;
  ratingKey: string;
  title: string;
  mediaType: 'movie' | 'show' | 'episode';
  grandparentRatingKey?: string;
}) {
  await db.execute(sql`
    INSERT INTO library_items (server_id, library_id, rating_key, title, media_type, grandparent_rating_key, file_size, created_at)
    VALUES (
      ${opts.serverId}::uuid,
      ${opts.libraryId ?? 'lib-1'},
      ${opts.ratingKey},
      ${opts.title},
      ${opts.mediaType},
      ${opts.grandparentRatingKey ?? null},
      1000000,
      NOW()
    )
  `);
}

async function insertPlayedState(opts: {
  serverId: string;
  serverUserId: string;
  ratingKey: string;
  mediaType: 'movie' | 'episode';
  seriesRatingKey?: string;
}) {
  await db.execute(sql`
    INSERT INTO played_states (server_id, server_user_id, rating_key, media_type, series_rating_key, synced_at)
    VALUES (
      ${opts.serverId}::uuid,
      ${opts.serverUserId}::uuid,
      ${opts.ratingKey},
      ${opts.mediaType},
      ${opts.seriesRatingKey ?? null},
      NOW()
    )
  `);
}

describe('played-state predicate - never-watched', () => {
  it('excludes a movie with a played_states row from never-watched even with no session', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-flip',
      title: 'Historically Watched Movie',
      mediaType: 'movie',
    });
    await insertPlayedState({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey: 'movie-flip',
      mediaType: 'movie',
    });

    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-real-never',
      title: 'Genuinely Never Watched Movie',
      mediaType: 'movie',
    });

    const app = await buildApp(libraryNeverWatchedRoute);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<NeverWatchedStatsResponse>();

      // Only the item with no played_states row remains never-watched.
      expect(body.totals.count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rolls a show up to watched via series_rating_key without touching library_items children', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'show-watched',
      title: 'Show With A Historical Play',
      mediaType: 'show',
    });
    // The played row references the SHOW's rating_key via series_rating_key,
    // from an episode play - it never touches library_items at all.
    await insertPlayedState({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey: 'ep-of-show-watched',
      mediaType: 'episode',
      seriesRatingKey: 'show-watched',
    });

    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'show-never-watched',
      title: 'Show With No Plays At All',
      mediaType: 'show',
    });

    const app = await buildApp(libraryNeverWatchedRoute);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}&mediaType=show`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<NeverWatchedStatsResponse>();

      expect(body.totals.count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('reports capability unsupported and no coverage for a Plex server, with unchanged never-watched behavior', async () => {
    const server = await createTestPlexServer();

    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'plex-movie-1',
      title: 'Plex Never Watched Movie',
      mediaType: 'movie',
    });

    const app = await buildApp(libraryNeverWatchedRoute);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<NeverWatchedStatsResponse>();

      // Plex has zero played_states rows - the predicate is a pure no-op,
      // standard session-based never-watched logic is unaffected.
      expect(body.totals.count).toBe(1);

      expect(body.playedStateCoverage).toBeDefined();
      const serverCoverage = body.playedStateCoverage!.servers.find(
        (s) => s.serverId === server.id
      );
      expect(serverCoverage?.capability).toBe('unsupported');
      expect(serverCoverage?.lastSyncedAt).toBeNull();
      expect(body.playedStateCoverage!.full).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('played-state predicate - stale.ts (both query paths)', () => {
  it('excludes a provably-watched-but-undatable item, and the paginated + empty-page summary paths agree', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    // 1. Genuinely never-watched: no session, no played_states row.
    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'stale-never-watched',
      title: 'Never Watched Movie',
      mediaType: 'movie',
    });

    // 2. Stale: has an old qualifying session (>= 2 min), so category = 'stale'.
    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'stale-old-watch',
      title: 'Watched Long Ago Movie',
      mediaType: 'movie',
    });
    await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey: 'stale-old-watch',
      stoppedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), // 200 days ago
      durationMs: 3600000,
    });

    // 3. Excluded entirely: no session (last_watched IS NULL) but a played_states
    // row exists - provably watched, but undatable (§5.2).
    await insertLibraryItem({
      serverId: server.id,
      ratingKey: 'stale-excluded',
      title: 'Historical Play, No Session',
      mediaType: 'movie',
    });
    await insertPlayedState({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey: 'stale-excluded',
      mediaType: 'movie',
    });

    const app = await buildApp(libraryStaleRoute);
    try {
      // Page 1: main combined query path (has rows).
      const page1 = await app.inject({
        method: 'GET',
        url: `/stale?serverIds=${server.id}&pageSize=1&page=1&staleDays=90`,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json<StaleResponseShape>();

      // Page 3 with pageSize=1: only 2 filtered rows exist, so this is beyond
      // the last page - forces the duplicated empty-page summary query.
      const page3 = await app.inject({
        method: 'GET',
        url: `/stale?serverIds=${server.id}&pageSize=1&page=3&staleDays=90`,
      });
      expect(page3.statusCode).toBe(200);
      const body3 = page3.json<StaleResponseShape>();
      expect(body3.items).toHaveLength(0);

      // Both query paths must agree on the same summary and total - the
      // excluded item must never surface in either.
      expect(body1.summary).toEqual(body3.summary);
      expect(body1.pagination.total).toBe(2);
      expect(body3.pagination.total).toBe(2);
      expect(body1.summary.neverWatched.count).toBe(1);
      expect(body1.summary.stale.count).toBe(1);

      // The excluded item's rating_key never appears across every page.
      const allItemIds = new Set<string>();
      for (let page = 1; page <= 2; page++) {
        const res = await app.inject({
          method: 'GET',
          url: `/stale?serverIds=${server.id}&pageSize=1&page=${page}&staleDays=90`,
        });
        for (const item of res.json<StaleResponseShape>().items) {
          allItemIds.add(item.id);
        }
      }
      expect(allItemIds.size).toBe(2);
    } finally {
      await app.close();
    }
  });
});
