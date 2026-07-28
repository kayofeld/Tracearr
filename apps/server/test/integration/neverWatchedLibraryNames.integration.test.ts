/**
 * Never Watched "by library" display name integration tests.
 *
 * The `by_library` breakdown joins the `libraries` dimension table (populated
 * by librarySync) to show a real display name instead of the raw library_id
 * section key. The table starts empty and is only backfilled on the next
 * sync, so the join must fall back to library_id when no row exists yet -
 * the UI must never render blank.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- neverWatchedLibraryNames
 */
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, type AuthUser, type NeverWatchedStatsResponse } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryNeverWatchedRoute } from '../../src/routes/library/neverWatched.js';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  await app.register(libraryNeverWatchedRoute);
  return app;
}

async function insertMovie(serverId: string, libraryId: string, ratingKey: string, title: string) {
  await db.execute(sql`
    INSERT INTO library_items (server_id, library_id, rating_key, title, media_type, file_size, created_at)
    VALUES (${serverId}::uuid, ${libraryId}, ${ratingKey}, ${title}, 'movie', 1000000, NOW())
  `);
}

async function upsertLibraryName(serverId: string, libraryId: string, name: string) {
  await db.execute(sql`
    INSERT INTO libraries (server_id, library_id, name, type)
    VALUES (${serverId}::uuid, ${libraryId}, ${name}, 'movie')
    ON CONFLICT (server_id, library_id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
  `);
}

describe('never-watched by-library display names', () => {
  it('uses the persisted libraries.name when a row exists', async () => {
    const server = await createTestServer({ type: 'plex' });
    await upsertLibraryName(server.id, 'lib-1', 'Movies');
    await insertMovie(server.id, 'lib-1', 'rk-1', 'Never Watched Movie');

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/never-watched?serverIds=${server.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    const entry = body.byLibrary.find((l) => l.libraryId === 'lib-1');
    expect(entry?.libraryName).toBe('Movies');
  });

  it('falls back to the raw library_id when no libraries row exists yet', async () => {
    const server = await createTestServer({ type: 'plex' });
    // Deliberately no upsertLibraryName call - table starts empty until the
    // next sync backfills it.
    await insertMovie(server.id, 'lib-unsynced', 'rk-2', 'Another Never Watched Movie');

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/never-watched?serverIds=${server.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json<NeverWatchedStatsResponse>();
    const entry = body.byLibrary.find((l) => l.libraryId === 'lib-unsynced');
    expect(entry?.libraryName).toBe('lib-unsynced');
  });

  it('reflects a rename after the libraries row is updated', async () => {
    const server = await createTestServer({ type: 'plex' });
    await upsertLibraryName(server.id, 'lib-3', 'Old Name');
    await insertMovie(server.id, 'lib-3', 'rk-3', 'Renamed Library Movie');

    const app = await buildApp();
    try {
      const before = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(before.json<NeverWatchedStatsResponse>().byLibrary[0]?.libraryName).toBe('Old Name');

      // Simulate the next sync renaming the library on the media server. A real
      // sync does two things, so this has to do both: it upserts the libraries
      // row AND calls invalidateLibraryCaches(), which drops the cached
      // never-watched payload. Updating only the row would leave the response
      // served from cache for up to CACHE_TTL.LIBRARY_NEVER_WATCHED (1 hour) and
      // the assertion below would read a stale name.
      await upsertLibraryName(server.id, 'lib-3', 'New Name');
      const cachedKeys = await app.redis.keys(`${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`);
      expect(cachedKeys.length).toBeGreaterThan(0);
      await app.redis.del(...cachedKeys);

      const after = await app.inject({
        method: 'GET',
        url: `/never-watched?serverIds=${server.id}`,
      });
      expect(after.json<NeverWatchedStatsResponse>().byLibrary[0]?.libraryName).toBe('New Name');
    } finally {
      await app.close();
    }
  });
});
