/**
 * Ombi connector route tests
 *
 * Owner-gated config/sync/status/mapping/purge endpoints, fully mocked (db,
 * the Ombi HTTP client, the sync queue) - no live network or Postgres/Redis.
 * Model: routes/library/__tests__/neverWatched.test.ts (fake authenticate/
 * requireOwner decorators + app.redis stub), routes/users/__tests__/bulkRemove.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../services/ombi.js', () => ({
  OmbiService: vi.fn(),
}));

vi.mock('../../services/settings.js', () => ({
  getOmbiSettings: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../../jobs/ombiSyncQueue.js', () => ({
  enqueueOmbiSync: vi.fn(),
  isOmbiSyncRunning: vi.fn(),
  buildRequesterResolver: vi.fn(),
  invalidateOmbiCaches: vi.fn(),
}));

import { db } from '../../db/client.js';
import { OmbiService } from '../../services/ombi.js';
import { getOmbiSettings, getSetting } from '../../services/settings.js';
import {
  enqueueOmbiSync,
  isOmbiSyncRunning,
  buildRequesterResolver,
  invalidateOmbiCaches,
} from '../../jobs/ombiSyncQueue.js';
import { ombiRoutes } from '../ombi.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });
  app.decorate('redis', {} as never);

  await app.register(ombiRoutes, { prefix: '/ombi' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}
function createViewerUser(): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds: [] };
}

function selectWhereLimit(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(result) }),
    }),
  };
}
function selectFromOnly(result: unknown[]) {
  return { from: vi.fn().mockResolvedValue(result) };
}
function mockInsertChain() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate };
}
function mockUpdateChain(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where, returning };
}
function mockDeleteWhereChain(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.delete).mockReturnValue({ where } as never);
  return { where, returning };
}

describe('Ombi connector routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ==========================================================================
  // POST /ombi/test-connection
  // ==========================================================================

  describe('POST /ombi/test-connection', () => {
    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://localhost:5420', apiKey: 'key' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('rejects a malformed body with 400', async () => {
      app = await buildTestApp(createOwnerUser());
      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://localhost:5420' }, // missing apiKey
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when construction rejects the URL (SSRF)', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(OmbiService).mockImplementationOnce(function () {
        throw new Error('169.254.169.254 is in the link-local range and cannot be probed');
      });

      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://169.254.169.254', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 200 with success:true on a valid connection', async () => {
      app = await buildTestApp(createOwnerUser());
      // Must be a `function`, not an arrow, so `new OmbiService(...)` works.
      vi.mocked(OmbiService).mockImplementationOnce(function () {
        return {
          testConnection: vi.fn().mockResolvedValue({ success: true, userCount: 33 }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://localhost:5420', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, userCount: 33 });
    });

    it('returns 200 with success:false on an auth failure (not a 4xx/5xx)', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(OmbiService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: false, error: 'Invalid Ombi API key' }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://localhost:5420', apiKey: 'wrong-key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: false, error: 'Invalid Ombi API key' });
    });

    it('returns 200 with success:false on a non-JSON (HTML) response', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(OmbiService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: false, error: 'Ombi returned a non-JSON response' }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/ombi/test-connection',
        payload: { url: 'http://localhost:5420', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(false);
    });
  });

  // ==========================================================================
  // POST /ombi/sync
  // ==========================================================================

  describe('POST /ombi/sync', () => {
    it('returns 202 with the jobId on success', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueOmbiSync).mockResolvedValue('job-123');

      const response = await app.inject({ method: 'POST', url: '/ombi/sync' });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ jobId: 'job-123' });
    });

    it('returns 400 when Ombi is not configured', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueOmbiSync).mockRejectedValue(new Error('Ombi is not configured'));

      const response = await app.inject({ method: 'POST', url: '/ombi/sync' });

      expect(response.statusCode).toBe(400);
    });

    it('returns 409 when a sync is already running', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueOmbiSync).mockRejectedValue(
        new Error('An Ombi sync is already in progress')
      );

      const response = await app.inject({ method: 'POST', url: '/ombi/sync' });

      expect(response.statusCode).toBe(409);
    });

    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({ method: 'POST', url: '/ombi/sync' });
      expect(response.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // GET /ombi/status
  // ==========================================================================

  describe('GET /ombi/status', () => {
    it('reports purgeAvailable=true only when disconnected AND rows remain', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getOmbiSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null });
      vi.mocked(getSetting).mockResolvedValue(null);
      vi.mocked(isOmbiSyncRunning).mockResolvedValue(false);
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ mediaType: 'movie', count: 5 }] } as never) // counts
        .mockResolvedValueOnce({ rows: [{ matched: 2, manual: 1, unattributed: 2 }] } as never) // attribution
        .mockResolvedValueOnce({ rows: [{ matched: 3, unmatched: 2 }] } as never); // mediaMatch

      const response = await app.inject({ method: 'GET', url: '/ombi/status' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.configured).toBe(false);
      expect(body.counts).toEqual({
        movieRequests: 5,
        tvRequests: 0,
        total: 5,
        skippedValidation: 0,
      });
      expect(body.purgeAvailable).toBe(true);
      expect(body.attribution).toEqual({ matched: 2, manual: 1, unattributed: 2 });
      expect(body.mediaMatch).toEqual({ matched: 3, unmatched: 2 });
    });

    it('reports purgeAvailable=false when configured, even with rows present', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getOmbiSettings).mockResolvedValue({
        ombiUrl: 'http://localhost:5420',
        ombiApiKey: 'key',
      });
      vi.mocked(getSetting).mockResolvedValue({
        lastRunAt: '2025-01-01T00:00:00.000Z',
        lastSuccessAt: '2025-01-01T00:00:00.000Z',
        lastError: null,
        skippedValidation: 0,
        moviePhaseOk: true,
        tvPhaseOk: true,
      });
      vi.mocked(isOmbiSyncRunning).mockResolvedValue(true);
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ mediaType: 'movie', count: 1 }] } as never)
        .mockResolvedValueOnce({ rows: [{ matched: 1, manual: 0, unattributed: 0 }] } as never)
        .mockResolvedValueOnce({ rows: [{ matched: 1, unmatched: 0 }] } as never);

      const response = await app.inject({ method: 'GET', url: '/ombi/status' });

      const body = response.json();
      expect(body.configured).toBe(true);
      expect(body.running).toBe(true);
      expect(body.purgeAvailable).toBe(false);
      expect(body.lastRunAt).toBe('2025-01-01T00:00:00.000Z');
    });
  });

  // ==========================================================================
  // GET /ombi/mappings
  // ==========================================================================

  describe('GET /ombi/mappings', () => {
    it('marks a resolved requester with empty suggestions, and an unresolved one with candidates', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              ombiUserId: 'ombi-1',
              ombiUsername: 'alice',
              ombiAlias: null,
              userId: 'user-1',
              matchMethod: 'username',
            },
            {
              ombiUserId: 'ombi-2',
              ombiUsername: 'shared',
              ombiAlias: null,
              userId: null,
              matchMethod: null,
            },
          ],
        } as never)
        .mockResolvedValueOnce({
          rows: [
            { ombiUserId: 'ombi-1', requestCount: 4 },
            { ombiUserId: 'ombi-2', requestCount: 1 },
          ],
        } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectFromOnly([]) as never) // ombiUserMappings (no stale entries)
        .mockReturnValueOnce(
          selectFromOnly([
            { id: 'user-1', username: 'alice' },
            { id: 'user-2', username: 'shared' },
            { id: 'user-3', username: 'SHARED' },
          ]) as never
        );

      const response = await app.inject({ method: 'GET', url: '/ombi/mappings' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const alice = body.requesters.find((r: { ombiUserId: string }) => r.ombiUserId === 'ombi-1');
      const shared = body.requesters.find((r: { ombiUserId: string }) => r.ombiUserId === 'ombi-2');

      expect(alice).toMatchObject({
        requestCount: 4,
        resolution: { type: 'username', userId: 'user-1', username: 'alice' },
        ambiguous: false,
        suggestions: [],
        stale: false,
      });
      expect(shared).toMatchObject({
        requestCount: 1,
        resolution: { type: 'unattributed', userId: null, username: null },
        ambiguous: true,
        stale: false,
      });
      expect(shared.suggestions).toHaveLength(2); // 'shared' and 'SHARED' users
    });

    it('flags a mapping row with no current requests as stale', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({ rows: [] } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(
          selectFromOnly([
            { ombiUserId: 'ombi-gone', ombiUsername: 'ghost', userId: null },
          ]) as never
        )
        .mockReturnValueOnce(selectFromOnly([]) as never);

      const response = await app.inject({ method: 'GET', url: '/ombi/mappings' });

      const body = response.json();
      expect(body.requesters).toEqual([
        {
          ombiUserId: 'ombi-gone',
          ombiUsername: 'ghost',
          ombiAlias: null,
          requestCount: 0,
          resolution: { type: 'manual', userId: null, username: null },
          ambiguous: false,
          suggestions: [],
          stale: true,
        },
      ]);
    });
  });

  // ==========================================================================
  // PUT /ombi/mappings/:ombiUserId
  // ==========================================================================

  describe('PUT /ombi/mappings/:ombiUserId', () => {
    it('returns 404 for an unknown target userId', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimit([]) as never); // target user lookup

      const response = await app.inject({
        method: 'PUT',
        url: `/ombi/mappings/ombi-1`,
        payload: { userId: randomUUID() },
      });

      expect(response.statusCode).toBe(404);
    });

    it('upserts the mapping, force-resolves matching rows, and invalidates caches', async () => {
      app = await buildTestApp(createOwnerUser());
      const targetUserId = randomUUID();
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimit([{ id: targetUserId }]) as never) // target user exists
        .mockReturnValueOnce(selectWhereLimit([{ ombiUsername: 'alice' }]) as never) // existing request row
        .mockReturnValueOnce(selectWhereLimit([]) as never); // existing mapping row (none)
      mockInsertChain();
      mockUpdateChain([{ id: 'r1' }, { id: 'r2' }]);

      const response = await app.inject({
        method: 'PUT',
        url: `/ombi/mappings/ombi-1`,
        payload: { userId: targetUserId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 2 });
      expect(invalidateOmbiCaches).toHaveBeenCalledTimes(1);
    });

    it('accepts userId: null to force "unattributed"', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimit([{ ombiUsername: 'azel' }]) as never)
        .mockReturnValueOnce(selectWhereLimit([]) as never);
      mockInsertChain();
      mockUpdateChain([{ id: 'r1' }]);

      const response = await app.inject({
        method: 'PUT',
        url: `/ombi/mappings/ombi-azel`,
        payload: { userId: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 1 });
    });

    it('rejects a malformed body with 400', async () => {
      app = await buildTestApp(createOwnerUser());
      const response = await app.inject({
        method: 'PUT',
        url: `/ombi/mappings/ombi-1`,
        payload: { userId: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // DELETE /ombi/mappings/:ombiUserId
  // ==========================================================================

  describe('DELETE /ombi/mappings/:ombiUserId', () => {
    it('returns 404 when no override exists', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([]);

      const response = await app.inject({ method: 'DELETE', url: '/ombi/mappings/ombi-1' });

      expect(response.statusCode).toBe(404);
    });

    it('re-resolves via the automatic pipeline and invalidates caches', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([{ ombiUserId: 'ombi-1' }]);
      vi.mocked(db.select).mockReturnValueOnce(
        selectWhereLimit([{ ombiUsername: 'alice' }]) as never
      );
      vi.mocked(buildRequesterResolver).mockResolvedValue({
        resolve: vi.fn().mockReturnValue({ userId: 'user-1', matchMethod: 'username' }),
      });
      mockUpdateChain([{ id: 'r1' }]);

      const response = await app.inject({ method: 'DELETE', url: '/ombi/mappings/ombi-1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 1 });
      expect(invalidateOmbiCaches).toHaveBeenCalledTimes(1);
    });

    it('returns updated:0 when the deleted override had no matching request rows', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([{ ombiUserId: 'ombi-gone' }]);
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimit([]) as never); // no sample row

      const response = await app.inject({ method: 'DELETE', url: '/ombi/mappings/ombi-gone' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 0 });
    });
  });

  // ==========================================================================
  // DELETE /ombi/data (purge)
  // ==========================================================================

  describe('DELETE /ombi/data', () => {
    it('returns 409 while the connector is still configured', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getOmbiSettings).mockResolvedValue({
        ombiUrl: 'http://localhost:5420',
        ombiApiKey: 'key',
      });

      const response = await app.inject({ method: 'DELETE', url: '/ombi/data' });

      expect(response.statusCode).toBe(409);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('purges both tables and invalidates caches once disconnected', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getOmbiSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null });
      const tx = {
        delete: vi
          .fn()
          .mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]) })
          .mockReturnValueOnce({
            returning: vi.fn().mockResolvedValue([{ ombiUserId: 'ombi-1' }]),
          }),
      };
      vi.mocked(db.transaction).mockImplementation(
        (cb: unknown) => (cb as (t: unknown) => unknown)(tx) as never
      );

      const response = await app.inject({ method: 'DELETE', url: '/ombi/data' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deletedRequests: 2, deletedMappings: 1 });
      expect(invalidateOmbiCaches).toHaveBeenCalledTimes(1);
    });

    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({ method: 'DELETE', url: '/ombi/data' });
      expect(response.statusCode).toBe(403);
    });
  });
});
