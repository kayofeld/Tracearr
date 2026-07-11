/**
 * top_shows_by_engagement.unique_viewers integration test.
 *
 * The all-time /stats/shows path reads from the top_shows_by_engagement view,
 * which used to count DISTINCT server accounts. A merged person (one identity,
 * two server accounts) watching the same show from both accounts was counted
 * as two viewers instead of one. Confirms the fixed view (and its consumer)
 * counts by identity (server_users.user_id), matching the date-filtered path.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- topShowsUniqueViewers
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { engagementRoutes } from '../../src/routes/stats/engagement.js';
import { sql } from 'drizzle-orm';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  await app.register(engagementRoutes as never);
  return app;
}

describe('top_shows_by_engagement unique_viewers', () => {
  it('counts a merged person watching one show from two accounts as one viewer (all-time)', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    const accountA = await createTestServerUser({ userId: person.id, serverId: serverA.id });
    const accountB = await createTestServerUser({ userId: person.id, serverId: serverB.id });

    const showTitle = 'Merged Viewer Show';
    await createTestSession({
      serverId: serverA.id,
      serverUserId: accountA.id,
      mediaType: 'episode',
      mediaTitle: `${showTitle} - S01E01`,
      grandparentTitle: showTitle,
      ratingKey: 'merged-show-ep-1',
      seasonNumber: 1,
      episodeNumber: 1,
      durationMs: 6_000_000,
      totalDurationMs: 7_200_000,
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: accountB.id,
      mediaType: 'episode',
      mediaTitle: `${showTitle} - S01E02`,
      grandparentTitle: showTitle,
      ratingKey: 'merged-show-ep-2',
      seasonNumber: 1,
      episodeNumber: 2,
      durationMs: 6_000_000,
      totalDurationMs: 7_200_000,
    });

    // top_shows_by_engagement is a plain view over daily_content_engagement,
    // which only reflects new data after a refresh.
    await db.execute(
      sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/shows?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const shows = response.json().data as { showTitle: string; uniqueViewers: number }[];
    const show = shows.find((s) => s.showTitle === showTitle);
    expect(show).toBeDefined();
    expect(show?.uniqueViewers).toBe(1);
  });
});
