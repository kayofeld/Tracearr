/**
 * Multi-server scoping integration tests for /stats/top-content and /stats/shows.
 *
 * Confirms both endpoints honor a `serverIds` subset (not just the legacy single
 * `serverId`), and that a non-owner can never widen results past their own
 * accessible servers by passing extra serverIds.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- statsMultiServerScoping
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { contentRoutes } from '../../src/routes/stats/content.js';
import { engagementRoutes } from '../../src/routes/stats/engagement.js';
import { sql } from 'drizzle-orm';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

function viewerAuth(serverIds: string[]): AuthUser {
  return { userId: 'viewer', username: 'viewer', role: 'viewer', serverIds };
}

async function buildApp(
  plugin: Parameters<typeof Fastify.prototype.register>[0],
  authUser: AuthUser
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  await app.register(plugin as never);
  return app;
}

describe('stats multi-server scoping', () => {
  describe('GET /stats/top-content', () => {
    it('only aggregates movies from the servers listed in serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Movie On B',
        mediaType: 'movie',
      });

      const app = await buildApp(contentRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverIds=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Movie On A');
      expect(titles).not.toContain('Movie On B');
    });

    it('still supports the legacy single serverId param', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Legacy Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Legacy Movie On B',
        mediaType: 'movie',
      });

      const app = await buildApp(contentRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverId=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Legacy Movie On A');
      expect(titles).not.toContain('Legacy Movie On B');
    });

    it('a non-owner cannot widen results past their own servers via serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Viewer Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Viewer Movie On B',
        mediaType: 'movie',
      });

      // Viewer only has access to serverA but asks for both servers explicitly.
      const app = await buildApp(contentRoutes, viewerAuth([serverA.id]));
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Viewer Movie On A');
      expect(titles).not.toContain('Viewer Movie On B');
    });
  });

  describe('GET /stats/shows', () => {
    it('only aggregates episodes from the servers listed in serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaType: 'episode',
        mediaTitle: 'Show On A - S01E01',
        grandparentTitle: 'Show On A',
        ratingKey: 'a-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaType: 'episode',
        mediaTitle: 'Show On B - S01E01',
        grandparentTitle: 'Show On B',
        ratingKey: 'b-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });

      // The engagement continuous aggregate only reflects data after a refresh.
      await db.execute(
        sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
      );

      const app = await buildApp(engagementRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/shows?period=all&serverIds=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const shows = (response.json().data as { showTitle: string }[]).map((s) => s.showTitle);
      expect(shows).toContain('Show On A');
      expect(shows).not.toContain('Show On B');
    });

    it('still supports the legacy single serverId param', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaType: 'episode',
        mediaTitle: 'Legacy Show On A - S01E01',
        grandparentTitle: 'Legacy Show On A',
        ratingKey: 'legacy-a-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaType: 'episode',
        mediaTitle: 'Legacy Show On B - S01E01',
        grandparentTitle: 'Legacy Show On B',
        ratingKey: 'legacy-b-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });

      await db.execute(
        sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
      );

      const app = await buildApp(engagementRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/shows?period=all&serverId=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const shows = (response.json().data as { showTitle: string }[]).map((s) => s.showTitle);
      expect(shows).toContain('Legacy Show On A');
      expect(shows).not.toContain('Legacy Show On B');
    });

    it('a non-owner cannot widen results past their own servers via serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaType: 'episode',
        mediaTitle: 'Viewer Show On A - S01E01',
        grandparentTitle: 'Viewer Show On A',
        ratingKey: 'viewer-a-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaType: 'episode',
        mediaTitle: 'Viewer Show On B - S01E01',
        grandparentTitle: 'Viewer Show On B',
        ratingKey: 'viewer-b-show-ep-1',
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });

      await db.execute(
        sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
      );

      const app = await buildApp(engagementRoutes, viewerAuth([serverA.id]));
      const response = await app.inject({
        method: 'GET',
        url: `/shows?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const shows = (response.json().data as { showTitle: string }[]).map((s) => s.showTitle);
      expect(shows).toContain('Viewer Show On A');
      expect(shows).not.toContain('Viewer Show On B');
    });
  });
});
