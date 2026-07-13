/**
 * Device compatibility matrix route tests
 *
 * Tests GET /device-compatibility/matrix:
 * - Single serverId (or no server param) keeps returning one flat matrix object
 * - serverIds[] batches every requested server into one query, keyed by server id
 * - resolveServerIds authorization semantics (strict 403 for serverId, silent
 *   intersection for serverIds[]) are preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock('../utils.js', () => ({
  resolveDateRange: vi.fn(() => ({
    start: new Date('2024-06-08T12:00:00Z'),
    end: new Date('2024-06-15T12:00:00Z'),
  })),
}));

import { db } from '../../../db/client.js';
import { devicesRoutes } from '../devices.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });

  await app.register(devicesRoutes, { prefix: '/stats' });

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

function createViewerUser(serverIds: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds,
  };
}

describe('Device Compatibility Matrix Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('single serverId (unchanged shape)', () => {
    it('returns one flat matrix object', async () => {
      const ownerUser = createOwnerUser();
      const serverId = randomUUID();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ codec: 'h264' }] } as never)
        .mockResolvedValueOnce({
          rows: [
            {
              device_type: 'Chrome',
              video_codec: 'h264',
              session_count: 10,
              direct_count: 8,
              direct_pct: 80,
            },
          ],
        } as never);

      const response = await app.inject({
        method: 'GET',
        url: `/stats/device-compatibility/matrix?serverId=${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        codecs: ['h264'],
        devices: [{ device: 'Chrome', codecs: { h264: { sessions: 10, directPct: 80 } } }],
      });
      expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(2);
    });

    it('rejects an explicit serverId a non-owner cannot access', async () => {
      const authorizedServer = randomUUID();
      const unauthorizedServer = randomUUID();
      const viewerUser = createViewerUser([authorizedServer]);
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/stats/device-compatibility/matrix?serverId=${unauthorizedServer}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns a combined matrix when no server param is given, for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ codec: 'hevc' }] } as never)
        .mockResolvedValueOnce({
          rows: [
            {
              device_type: 'Roku',
              video_codec: 'hevc',
              session_count: 5,
              direct_count: 5,
              direct_pct: 100,
            },
          ],
        } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/device-compatibility/matrix',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.codecs).toEqual(['hevc']);
      expect(body.devices).toHaveLength(1);
    });

    it('returns a combined matrix scoped to accessible servers when no server param is given, for a non-owner', async () => {
      const viewerUser = createViewerUser([randomUUID()]);
      app = await buildTestApp(viewerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({ rows: [] } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/device-compatibility/matrix',
      });

      // Must not come back empty due to indexing off the wrong id - it should
      // still run the query scoped to the user's own accessible servers.
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ codecs: [], devices: [] });
    });
  });

  describe('serverIds[] (batched, keyed response)', () => {
    it('runs one grouped query and returns results keyed by server id', async () => {
      const ownerUser = createOwnerUser();
      const serverA = randomUUID();
      const serverB = randomUUID();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            { server_id: serverA, codec: 'h264' },
            { server_id: serverB, codec: 'hevc' },
          ],
        } as never)
        .mockResolvedValueOnce({
          rows: [
            {
              server_id: serverA,
              device_type: 'Chrome',
              video_codec: 'h264',
              session_count: 10,
              direct_count: 8,
              direct_pct: 80,
            },
            {
              server_id: serverB,
              device_type: 'Roku',
              video_codec: 'hevc',
              session_count: 5,
              direct_count: 5,
              direct_pct: 100,
            },
          ],
        } as never);

      const response = await app.inject({
        method: 'GET',
        url: `/stats/device-compatibility/matrix?serverIds=${serverA}&serverIds=${serverB}`,
      });

      expect(response.statusCode).toBe(200);
      expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(2);

      const body = response.json();
      expect(Object.keys(body).sort()).toEqual([serverA, serverB].sort());
      expect(body[serverA]).toEqual({
        codecs: ['h264'],
        devices: [{ device: 'Chrome', codecs: { h264: { sessions: 10, directPct: 80 } } }],
      });
      expect(body[serverB]).toEqual({
        codecs: ['hevc'],
        devices: [{ device: 'Roku', codecs: { hevc: { sessions: 5, directPct: 100 } } }],
      });
    });

    it('silently intersects serverIds[] with the accessible servers for a non-owner', async () => {
      const accessibleServer = randomUUID();
      const inaccessibleServer = randomUUID();
      const viewerUser = createViewerUser([accessibleServer]);
      app = await buildTestApp(viewerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ server_id: accessibleServer, codec: 'h264' }] } as never)
        .mockResolvedValueOnce({
          rows: [
            {
              server_id: accessibleServer,
              device_type: 'Chrome',
              video_codec: 'h264',
              session_count: 3,
              direct_count: 3,
              direct_pct: 100,
            },
          ],
        } as never);

      const response = await app.inject({
        method: 'GET',
        url: `/stats/device-compatibility/matrix?serverIds=${accessibleServer}&serverIds=${inaccessibleServer}`,
      });

      // No 403 - the inaccessible id is silently dropped rather than rejected.
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body)).toEqual([accessibleServer]);
    });

    it('returns an empty map for a non-owner with no accessible servers', async () => {
      const viewerUser = createViewerUser([]);
      app = await buildTestApp(viewerUser);

      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({ rows: [] } as never);

      const requestedServer = randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/stats/device-compatibility/matrix?serverIds=${requestedServer}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
    });
  });
});
