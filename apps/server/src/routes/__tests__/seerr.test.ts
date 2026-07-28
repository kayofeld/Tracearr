/**
 * Seerr connector route tests
 *
 * Owner-gated config/sync/status/mapping/purge endpoints, fully mocked (db,
 * the Seerr HTTP client, the sync queue) - no live network or Postgres/Redis.
 * Model: routes/__tests__/ombi.test.ts (fake authenticate/requireOwner
 * decorators + app.redis stub).
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

vi.mock('../../services/seerr.js', () => ({
  SeerrService: vi.fn(),
}));

vi.mock('../../services/settings.js', () => ({
  getSeerrSettings: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../../jobs/seerrSyncQueue.js', () => ({
  enqueueSeerrSync: vi.fn(),
  isSeerrSyncRunning: vi.fn(),
  buildSeerrRequesterResolver: vi.fn(),
  invalidateSeerrCaches: vi.fn(),
}));

import { db } from '../../db/client.js';
import { SeerrService } from '../../services/seerr.js';
import { getSeerrSettings, getSetting } from '../../services/settings.js';
import {
  enqueueSeerrSync,
  isSeerrSyncRunning,
  buildSeerrRequesterResolver,
  invalidateSeerrCaches,
} from '../../jobs/seerrSyncQueue.js';
import { seerrRoutes } from '../seerr.js';

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

  await app.register(seerrRoutes, { prefix: '/seerr' });
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
function selectFromWhereOnly(result: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(result) }) };
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

describe('Seerr connector routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ==========================================================================
  // POST /seerr/test-connection
  // ==========================================================================

  describe('POST /seerr/test-connection', () => {
    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055', apiKey: 'key' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('rejects a malformed body with 400', async () => {
      app = await buildTestApp(createOwnerUser());
      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055' }, // missing apiKey
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when construction rejects the URL (SSRF)', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(SeerrService).mockImplementationOnce(function () {
        throw new Error('169.254.169.254 is in the link-local range and cannot be probed');
      });

      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://169.254.169.254', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 200 with success:true on a valid connection', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(SeerrService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: true, version: '3.4.0', userCount: 46 }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, version: '3.4.0', userCount: 46 });
    });

    it('returns 200 with success:false on an auth failure (not a 4xx/5xx)', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(SeerrService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: false, error: 'Invalid Seerr API key' }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055', apiKey: 'wrong-key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: false, error: 'Invalid Seerr API key' });
    });

    it('returns 200 with success:false on a non-JSON (HTML) response', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(SeerrService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: false, error: 'Seerr returned a non-JSON response' }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055', apiKey: 'key' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(false);
    });

    it('never echoes the submitted API key back in the response body', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(SeerrService).mockImplementationOnce(function () {
        return {
          testConnection: vi
            .fn()
            .mockResolvedValue({ success: true, version: '3.4.0', userCount: 1 }),
        } as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/seerr/test-connection',
        payload: { url: 'http://localhost:5055', apiKey: 'top-secret-key' },
      });

      expect(response.body).not.toContain('top-secret-key');
    });
  });

  // ==========================================================================
  // POST /seerr/sync
  // ==========================================================================

  describe('POST /seerr/sync', () => {
    it('returns 202 with the jobId on success', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueSeerrSync).mockResolvedValue('job-123');

      const response = await app.inject({ method: 'POST', url: '/seerr/sync' });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ jobId: 'job-123' });
    });

    it('returns 400 when Seerr is not configured', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueSeerrSync).mockRejectedValue(new Error('Seerr is not configured'));

      const response = await app.inject({ method: 'POST', url: '/seerr/sync' });

      expect(response.statusCode).toBe(400);
    });

    it('returns 409 when a sync is already running', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(enqueueSeerrSync).mockRejectedValue(
        new Error('A Seerr sync is already in progress')
      );

      const response = await app.inject({ method: 'POST', url: '/seerr/sync' });

      expect(response.statusCode).toBe(409);
    });

    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({ method: 'POST', url: '/seerr/sync' });
      expect(response.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // GET /seerr/status
  // ==========================================================================

  describe('GET /seerr/status', () => {
    it('reports purgeAvailable=true only when disconnected AND rows remain', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });
      vi.mocked(getSetting).mockResolvedValue(null);
      vi.mocked(isSeerrSyncRunning).mockResolvedValue(false);
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ mediaType: 'movie', count: 5 }] } as never) // counts
        .mockResolvedValueOnce({ rows: [{ matched: 2, manual: 1, unattributed: 2 }] } as never) // attribution
        .mockResolvedValueOnce({ rows: [{ matched: 3, unmatched: 2 }] } as never) // mediaMatch
        .mockResolvedValueOnce({ rows: [{ count: 0 }] } as never); // mappingCount

      const response = await app.inject({ method: 'GET', url: '/seerr/status' });

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
      vi.mocked(getSeerrSettings).mockResolvedValue({
        seerrUrl: 'http://localhost:5055',
        seerrApiKey: 'key',
      });
      vi.mocked(getSetting).mockResolvedValue({
        lastRunAt: '2025-01-01T00:00:00.000Z',
        lastSuccessAt: '2025-01-01T00:00:00.000Z',
        lastError: null,
        skippedValidation: 0,
      });
      vi.mocked(isSeerrSyncRunning).mockResolvedValue(true);
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ mediaType: 'movie', count: 1 }] } as never)
        .mockResolvedValueOnce({ rows: [{ matched: 1, manual: 0, unattributed: 0 }] } as never)
        .mockResolvedValueOnce({ rows: [{ matched: 1, unmatched: 0 }] } as never)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] } as never); // mappingCount - irrelevant while configured

      const response = await app.inject({ method: 'GET', url: '/seerr/status' });

      const body = response.json();
      expect(body.configured).toBe(true);
      expect(body.running).toBe(true);
      expect(body.purgeAvailable).toBe(false);
      expect(body.lastRunAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('reports purgeAvailable=true when disconnected with zero requests but orphaned mappings remain', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });
      vi.mocked(getSetting).mockResolvedValue(null);
      vi.mocked(isSeerrSyncRunning).mockResolvedValue(false);
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as never) // counts - zero requests
        .mockResolvedValueOnce({ rows: [{ matched: 0, manual: 0, unattributed: 0 }] } as never)
        .mockResolvedValueOnce({ rows: [{ matched: 0, unmatched: 0 }] } as never)
        .mockResolvedValueOnce({ rows: [{ count: 2 }] } as never); // mappingCount - orphaned overrides

      const response = await app.inject({ method: 'GET', url: '/seerr/status' });

      const body = response.json();
      expect(body.counts.total).toBe(0);
      expect(body.purgeAvailable).toBe(true);
    });
  });

  // ==========================================================================
  // GET /seerr/mappings
  // ==========================================================================

  describe('GET /seerr/mappings', () => {
    it('marks a resolved requester with empty suggestions, and an unresolved one with candidates', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              seerrUserId: 'seerr-1',
              seerrUsername: 'alice',
              seerrAlias: null,
              sourceExternalUserId: null,
              userId: 'user-1',
              matchMethod: 'username',
            },
            {
              seerrUserId: 'seerr-2',
              seerrUsername: 'shared',
              seerrAlias: null,
              sourceExternalUserId: null,
              userId: null,
              matchMethod: null,
            },
          ],
        } as never)
        .mockResolvedValueOnce({
          rows: [
            { seerrUserId: 'seerr-1', requestCount: 4 },
            { seerrUserId: 'seerr-2', requestCount: 1 },
          ],
        } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectFromWhereOnly([]) as never) // mediaRequestUserMappings (no stale entries)
        .mockReturnValueOnce(
          selectFromOnly([
            { id: 'user-1', username: 'alice' },
            { id: 'user-2', username: 'shared' },
            { id: 'user-3', username: 'SHARED' },
          ]) as never
        )
        .mockReturnValueOnce(selectFromOnly([]) as never); // serverUsers - no external-id candidates

      const response = await app.inject({ method: 'GET', url: '/seerr/mappings' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const alice = body.requesters.find(
        (r: { seerrUserId: string }) => r.seerrUserId === 'seerr-1'
      );
      const shared = body.requesters.find(
        (r: { seerrUserId: string }) => r.seerrUserId === 'seerr-2'
      );

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

    it('flags ambiguous via the external-id tier even when the username is unambiguous', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              seerrUserId: 'seerr-3',
              seerrUsername: 'onlyone',
              seerrAlias: null,
              sourceExternalUserId: 'shared-guid',
              userId: null,
              matchMethod: null,
            },
          ],
        } as never)
        .mockResolvedValueOnce({ rows: [{ seerrUserId: 'seerr-3', requestCount: 1 }] } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectFromWhereOnly([]) as never)
        .mockReturnValueOnce(selectFromOnly([{ id: 'user-1', username: 'onlyone' }]) as never)
        .mockReturnValueOnce(
          selectFromOnly([
            { externalId: 'shared-guid', plexAccountId: null, userId: 'user-1' },
            { externalId: 'shared-guid', plexAccountId: null, userId: 'user-2' },
          ]) as never
        );

      const response = await app.inject({ method: 'GET', url: '/seerr/mappings' });

      const body = response.json();
      const row = body.requesters.find((r: { seerrUserId: string }) => r.seerrUserId === 'seerr-3');
      expect(row.ambiguous).toBe(true);
      expect(row.suggestions).toHaveLength(2); // external-id candidates preferred over username's single match
    });

    it('does not flag a resolved requester as ambiguous just because its username separately collides (CR-4)', async () => {
      // Resolved via the external-id tier (unique match), but its username
      // happens to collide with another Tracearr user - the auto-match
      // still succeeded, so contract §5.1's "auto-match refused" must be
      // false here (pre-fix: ambiguous was true purely from the username
      // collision, regardless of the already-successful resolution).
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              seerrUserId: 'seerr-4',
              seerrUsername: 'bob',
              seerrAlias: null,
              sourceExternalUserId: 'ext-guid-5',
              userId: 'user-5',
              matchMethod: 'provider',
            },
          ],
        } as never)
        .mockResolvedValueOnce({ rows: [{ seerrUserId: 'seerr-4', requestCount: 2 }] } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectFromWhereOnly([]) as never)
        .mockReturnValueOnce(
          selectFromOnly([
            { id: 'user-5', username: 'bob' },
            { id: 'user-6', username: 'BOB' },
          ]) as never
        )
        .mockReturnValueOnce(
          selectFromOnly([
            { externalId: 'ext-guid-5', plexAccountId: null, userId: 'user-5' },
          ]) as never
        );

      const response = await app.inject({ method: 'GET', url: '/seerr/mappings' });

      const body = response.json();
      const row = body.requesters.find((r: { seerrUserId: string }) => r.seerrUserId === 'seerr-4');
      expect(row.resolution).toEqual({ type: 'provider', userId: 'user-5', username: 'bob' });
      expect(row.ambiguous).toBe(false);
      expect(row.suggestions).toEqual([]);
    });

    it('flags a mapping row with no current requests as stale', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({
          rows: [],
        } as never);
      vi.mocked(db.select)
        .mockReturnValueOnce(
          selectFromWhereOnly([
            { source: 'seerr', sourceUserId: 'seerr-gone', sourceUsername: 'ghost', userId: null },
          ]) as never
        )
        .mockReturnValueOnce(selectFromOnly([]) as never)
        .mockReturnValueOnce(selectFromOnly([]) as never);

      const response = await app.inject({ method: 'GET', url: '/seerr/mappings' });

      const body = response.json();
      expect(body.requesters).toEqual([
        {
          seerrUserId: 'seerr-gone',
          seerrUsername: 'ghost',
          seerrDisplayName: null,
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
  // PUT /seerr/mappings/:seerrUserId
  // ==========================================================================

  describe('PUT /seerr/mappings/:seerrUserId', () => {
    it('returns 404 for an unknown target userId', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimit([]) as never); // target user lookup

      const response = await app.inject({
        method: 'PUT',
        url: `/seerr/mappings/seerr-1`,
        payload: { userId: randomUUID() },
      });

      expect(response.statusCode).toBe(404);
    });

    it('upserts the mapping, force-resolves matching rows, and invalidates caches', async () => {
      app = await buildTestApp(createOwnerUser());
      const targetUserId = randomUUID();
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimit([{ id: targetUserId }]) as never) // target user exists
        .mockReturnValueOnce(selectWhereLimit([{ sourceUsername: 'alice' }]) as never) // existing request row
        .mockReturnValueOnce(selectWhereLimit([]) as never); // existing mapping row (none)
      mockInsertChain();
      mockUpdateChain([{ id: 'r1' }, { id: 'r2' }]);

      const response = await app.inject({
        method: 'PUT',
        url: `/seerr/mappings/seerr-1`,
        payload: { userId: targetUserId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 2 });
      expect(invalidateSeerrCaches).toHaveBeenCalledTimes(1);
    });

    it('accepts userId: null to force "unattributed"', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhereLimit([{ sourceUsername: 'azel' }]) as never)
        .mockReturnValueOnce(selectWhereLimit([]) as never);
      mockInsertChain();
      mockUpdateChain([{ id: 'r1' }]);

      const response = await app.inject({
        method: 'PUT',
        url: `/seerr/mappings/seerr-azel`,
        payload: { userId: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 1 });
    });

    it('rejects a malformed body with 400', async () => {
      app = await buildTestApp(createOwnerUser());
      const response = await app.inject({
        method: 'PUT',
        url: `/seerr/mappings/seerr-1`,
        payload: { userId: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a seerrUserId longer than the column width (64 chars) with 400 instead of a DB error (SEC-05)', async () => {
      app = await buildTestApp(createOwnerUser());
      const response = await app.inject({
        method: 'PUT',
        url: `/seerr/mappings/${'x'.repeat(65)}`,
        payload: { userId: null },
      });
      expect(response.statusCode).toBe(400);
      expect(db.select).not.toHaveBeenCalled(); // rejected before any DB lookup
    });
  });

  // ==========================================================================
  // DELETE /seerr/mappings/:seerrUserId
  // ==========================================================================

  describe('DELETE /seerr/mappings/:seerrUserId', () => {
    it('returns 404 when no override exists', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([]);

      const response = await app.inject({ method: 'DELETE', url: '/seerr/mappings/seerr-1' });

      expect(response.statusCode).toBe(404);
    });

    it('rejects a seerrUserId longer than the column width (64 chars) with 400 instead of a DB error (SEC-05)', async () => {
      app = await buildTestApp(createOwnerUser());

      const response = await app.inject({
        method: 'DELETE',
        url: `/seerr/mappings/${'x'.repeat(65)}`,
      });

      expect(response.statusCode).toBe(400);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('re-resolves via the FULL automatic pipeline (incl. external id, unlike Ombi) and invalidates caches', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([{ sourceUserId: 'seerr-1' }]);
      vi.mocked(db.select).mockReturnValueOnce(
        selectWhereLimit([{ sourceUsername: 'alice', sourceExternalUserId: 'jf-guid-1' }]) as never
      );
      const resolveFn = vi.fn().mockReturnValue({ userId: 'user-1', matchMethod: 'provider' });
      vi.mocked(buildSeerrRequesterResolver).mockResolvedValue({ resolve: resolveFn });
      mockUpdateChain([{ id: 'r1' }]);

      const response = await app.inject({ method: 'DELETE', url: '/seerr/mappings/seerr-1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 1 });
      expect(resolveFn).toHaveBeenCalledWith({
        seerrUserId: 'seerr-1',
        seerrUsername: 'alice',
        seerrAlias: null,
        externalUserId: 'jf-guid-1', // passed through - unlike Ombi's forced null (ADR 0008)
      });
      expect(invalidateSeerrCaches).toHaveBeenCalledTimes(1);
    });

    it('returns updated:0 when the deleted override had no matching request rows', async () => {
      app = await buildTestApp(createOwnerUser());
      mockDeleteWhereChain([{ sourceUserId: 'seerr-gone' }]);
      vi.mocked(db.select).mockReturnValueOnce(selectWhereLimit([]) as never); // no sample row

      const response = await app.inject({ method: 'DELETE', url: '/seerr/mappings/seerr-gone' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 0 });
    });
  });

  // ==========================================================================
  // DELETE /seerr/data (purge)
  // ==========================================================================

  describe('DELETE /seerr/data', () => {
    it('returns 409 while the connector is still configured', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getSeerrSettings).mockResolvedValue({
        seerrUrl: 'http://localhost:5055',
        seerrApiKey: 'key',
      });

      const response = await app.inject({ method: 'DELETE', url: '/seerr/data' });

      expect(response.statusCode).toBe(409);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('purges both tables (scoped to seerr) and invalidates caches once disconnected', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });
      const tx = {
        delete: vi
          .fn()
          .mockReturnValueOnce({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]),
            }),
          })
          .mockReturnValueOnce({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ sourceUserId: 'seerr-1' }]),
            }),
          }),
      };
      vi.mocked(db.transaction).mockImplementation(
        (cb: unknown) => (cb as (t: unknown) => unknown)(tx) as never
      );

      const response = await app.inject({ method: 'DELETE', url: '/seerr/data' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deletedRequests: 2, deletedMappings: 1 });
      expect(tx.delete).toHaveBeenCalledTimes(2);
      expect(invalidateSeerrCaches).toHaveBeenCalledTimes(1);
    });

    it('rejects non-owners', async () => {
      app = await buildTestApp(createViewerUser());
      const response = await app.inject({ method: 'DELETE', url: '/seerr/data' });
      expect(response.statusCode).toBe(403);
    });
  });
});
