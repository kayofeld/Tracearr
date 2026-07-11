/**
 * Merged-identity stats integration tests
 *
 * Confirms every leaderboard and user-count surface treats a merged person
 * (one identity, multiple server accounts) as ONE human, not one per account.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mergedIdentityStats
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { usersRoutes } from '../../src/routes/stats/users.js';
import { bandwidthRoutes } from '../../src/routes/stats/bandwidth.js';
import { sessionRoutes } from '../../src/routes/sessions.js';
import { libraryTopContentRoute } from '../../src/routes/library/topContent.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import { getDashboardStats } from '../../src/services/dashboardStats.js';
import { initPreparedStatements } from '../../src/db/prepared.js';
import { sql } from 'drizzle-orm';

function ownerAuth(userId: string) {
  return { userId, username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp(plugin: Parameters<typeof Fastify.prototype.register>[0]) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = ownerAuth(request.headers['x-test-user-id'] ?? 'owner');
  });
  await app.register(plugin as any);
  return app;
}

describe('merged identity stats', () => {
  beforeAll(() => {
    // Dashboard stats' no-filter branch uses prepared statements, which are
    // only created by server startup in production - initialize them here.
    initPreparedStatements();
  });

  describe('GET /top-users', () => {
    it('returns one entry for a merged person with plays/watch time summed, identity trust, and a representative serverUserId', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });

      const target = await createTestUser({ role: 'member', name: 'Merged Person' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({
        userId: target.id,
        serverId: serverA.id,
        trustScore: 90,
        sessionCount: 10,
      });
      const sourceSu = await createTestServerUser({
        userId: source.id,
        serverId: serverB.id,
        trustScore: 50,
        sessionCount: 30,
      });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 900_000,
        totalDurationMs: 7_200_000,
      });

      const unmerged = await createTestUser({ role: 'member', name: 'Solo Person' });
      const unmergedSu = await createTestServerUser({ userId: unmerged.id, serverId: serverA.id });
      await createTestSession({
        serverId: serverA.id,
        serverUserId: unmergedSu.id,
        durationMs: 300_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(usersRoutes);
      const response = await app.inject({ method: 'GET', url: '/top-users?period=all' });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const rows = body.data as {
        userId: string;
        serverUserId: string;
        playCount: number;
        watchTimeHours: number;
        trustScore: number;
        identityServers?: { id: string; name: string }[];
      }[];

      const mergedRows = rows.filter((r) => r.userId === target.id);
      expect(mergedRows).toHaveLength(1);
      const mergedRow = mergedRows[0]!;
      // Watch time summed across both accounts, rounded to 1 decimal by the route:
      // Math.round((600000 + 900000) / 3600000 * 10) / 10
      expect(mergedRow.watchTimeHours).toBe(0.4);
      expect(mergedRow.playCount).toBe(2);
      // Representative account chosen by session count tiebreak (source has 30 > target's 10)
      expect(mergedRow.serverUserId).toBe(sourceSu.id);
      // Identity aggregate trust (weighted by session count: (90*10 + 50*30) / 40 = 60),
      // not either account's own score
      expect(mergedRow.trustScore).toBe(60);
      expect(mergedRow.identityServers?.map((s) => s.id).sort()).toEqual(
        [serverA.id, serverB.id].sort()
      );

      const unmergedRows = rows.filter((r) => r.userId === unmerged.id);
      expect(unmergedRows).toHaveLength(1);
      expect(unmergedRows[0]?.playCount).toBe(1);
      expect(unmergedRows[0]?.serverUserId).toBe(unmergedSu.id);
    });

    it('only counts sessions on the selected servers when serverIds narrows the request', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });

      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 900_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(usersRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/top-users?period=all&serverIds=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const rows = body.data as { userId: string; playCount: number; watchTimeHours: number }[];
      const row = rows.find((r) => r.userId === target.id);

      expect(row).toBeDefined();
      // Only serverA's session counts - not the 900_000ms serverB session
      expect(row?.playCount).toBe(1);
      expect(row?.watchTimeHours).toBe(0.2);
    });
  });

  describe('dashboard active users', () => {
    it('counts a merged person once with no server filter (prepared-statement branch)', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const since = new Date(Date.now() - 60 * 60 * 1000);
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        startedAt: since,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        startedAt: since,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const stats = await getDashboardStats({ serverIds: undefined, timezone: 'UTC' });
      expect(stats.activeUsersToday).toBe(1);
    });

    it('counts a merged person once when scoped to specific servers (dynamic-query branch)', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const since = new Date(Date.now() - 60 * 60 * 1000);
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        startedAt: since,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        startedAt: since,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const stats = await getDashboardStats({
        serverIds: [serverA.id, serverB.id],
        timezone: 'UTC',
      });
      expect(stats.activeUsersToday).toBe(1);
    });
  });

  describe('GET /sessions/history/aggregates', () => {
    it('counts unique users by identity, not by account', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const solo = await createTestUser({ role: 'member' });
      const soloSu = await createTestServerUser({ userId: solo.id, serverId: serverA.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverA.id,
        serverUserId: soloSu.id,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(sessionRoutes);
      const response = await app.inject({ method: 'GET', url: '/history/aggregates' });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Merged person (1) + solo person (1) = 2, not 3 accounts
      expect(body.uniqueUsers).toBe(2);
    });
  });

  describe('GET /bandwidth/top-users and /bandwidth/summary', () => {
    it('returns one bandwidth row for a merged person and counts unique users by identity', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
        bitrate: 5000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 600_000,
        bitrate: 8000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(bandwidthRoutes);

      const topUsersResponse = await app.inject({
        method: 'GET',
        url: '/bandwidth/top-users?period=all',
      });
      const summaryResponse = await app.inject({
        method: 'GET',
        url: '/bandwidth/summary?period=all',
      });
      await app.close();

      expect(topUsersResponse.statusCode).toBe(200);
      const topUsersBody = topUsersResponse.json();
      const rows = topUsersBody.data as { serverUserId: string; totalBytes: number }[];
      const mergedRows = rows.filter(
        (r) => r.serverUserId === targetSu.id || r.serverUserId === sourceSu.id
      );
      expect(mergedRows).toHaveLength(1);
      expect(mergedRows[0]?.totalBytes).toBeGreaterThan(0);

      expect(summaryResponse.statusCode).toBe(200);
      const summaryBody = summaryResponse.json();
      expect(summaryBody.uniqueUsers).toBe(1);
    });
  });

  describe('GET /library/top-movies (multi-server)', () => {
    it('counts a person watching the same title on two servers as one unique viewer', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const sharedTitle = 'Cross Server Movie';
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        mediaTitle: sharedTitle,
        ratingKey: 'a-rk-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        mediaTitle: sharedTitle,
        ratingKey: 'b-rk-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      // The engagement continuous aggregate only reflects data after a refresh.
      await db.execute(
        sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
      );

      const app = await buildApp(libraryTopContentRoute);
      const response = await app.inject({
        method: 'GET',
        url: `/top-movies?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const items = body.items as { title: string; uniqueViewers: number; serverIds: string[] }[];
      const merged = items.find((i) => i.title === sharedTitle);

      expect(merged).toBeDefined();
      expect(merged?.serverIds.sort()).toEqual([serverA.id, serverB.id].sort());
      expect(merged?.uniqueViewers).toBe(1);
    });
  });
});
