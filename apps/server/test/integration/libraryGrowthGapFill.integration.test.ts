/**
 * Library growth gap-fill integration tests.
 *
 * /library/growth emits one row per (day, server). When a server skips a sync
 * day, summing per-day totals across servers on the frontend used to dip -
 * not because the library shrank, just because one server's contribution
 * went missing for that day. This confirms the route now carries each
 * server's last known totals forward through its own gaps, while leaving
 * single-server output untouched.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- libraryGrowthGapFill
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryGrowthRoute } from '../../src/routes/library/growth.js';

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
  await app.register(libraryGrowthRoute);
  return app;
}

async function insertSnapshot(
  serverId: string,
  libraryId: string,
  day: string,
  movieCount: number
) {
  await db.execute(sql`
    INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size, movie_count)
    VALUES (${serverId}::uuid, ${libraryId}, ${day}::timestamptz, ${movieCount}, 0, ${movieCount})
  `);
}

describe('library growth gap-fill', () => {
  it("carries a server's last known total forward on a day it has no snapshot, so the combined total does not dip", async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const day1 = '2024-01-01T00:00:00Z';
    const day2 = '2024-01-02T00:00:00Z';
    const day3 = '2024-01-03T00:00:00Z';

    // Server A reports every day, growing steadily.
    await insertSnapshot(serverA.id, 'lib-a', day1, 10);
    await insertSnapshot(serverA.id, 'lib-a', day2, 12);
    await insertSnapshot(serverA.id, 'lib-a', day3, 14);

    // Server B skips day2 (no sync that day) but has real totals on day1 and day3.
    await insertSnapshot(serverB.id, 'lib-b', day1, 20);
    await insertSnapshot(serverB.id, 'lib-b', day3, 22);

    await db.execute(
      sql`CALL refresh_continuous_aggregate('library_stats_daily'::regclass, NULL, NULL)`
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/growth?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const movies = response.json().movies as { day: string; total: number; serverId: string }[];

    const combinedTotal = (day: string) =>
      movies.filter((m) => m.day === day).reduce((sum, m) => sum + m.total, 0);

    // Without gap-fill, day 2's combined total would only be A's 12 (B's
    // contribution missing that day), dipping below day 1's combined 30.
    // With gap-fill, B carries its day-1 total (20) forward through the gap.
    expect(combinedTotal('2024-01-01')).toBe(30);
    expect(combinedTotal('2024-01-02')).toBe(32);
    expect(combinedTotal('2024-01-03')).toBe(36);
  });

  it('leaves single-server output unchanged: only real snapshot days are returned, no fabricated points', async () => {
    const serverA = await createTestServer({ type: 'plex' });

    const day1 = '2024-02-01T00:00:00Z';
    const day3 = '2024-02-03T00:00:00Z';

    // Server A has a gap on day 2 - single-server output should skip it
    // entirely rather than fabricate a carried-forward point.
    await insertSnapshot(serverA.id, 'lib-a', day1, 5);
    await insertSnapshot(serverA.id, 'lib-a', day3, 7);

    await db.execute(
      sql`CALL refresh_continuous_aggregate('library_stats_daily'::regclass, NULL, NULL)`
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/growth?period=all&serverIds=${serverA.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const movies = response.json().movies as { day: string; total: number }[];

    expect(movies.map((m) => m.day)).toEqual(['2024-02-01', '2024-02-03']);
    expect(movies.map((m) => m.total)).toEqual([5, 7]);
  });
});
