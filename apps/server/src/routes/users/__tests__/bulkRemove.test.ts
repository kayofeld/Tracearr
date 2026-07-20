/**
 * POST /users/bulk/remove tests
 *
 * Owner-only soft-remove of server users (sets removedAt), with the db mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { listRoutes } from '../list.js';

const mockDb = vi.mocked(db);

function createAuthUser(role: AuthUser['role']): AuthUser {
  return { userId: randomUUID(), username: 'tester', role, serverIds: [] };
}

function mockUpdateReturning(rows: { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValue({ set } as never);
  return { set, where, returning };
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });
  await app.register(listRoutes, { prefix: '/users' });
  return app;
}

describe('POST /users/bulk/remove', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('soft-removes the given server users for an owner', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    const ids = [randomUUID(), randomUUID()];
    const { set } = mockUpdateReturning(ids.map((id) => ({ id })));

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/remove',
      payload: { ids },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, removed: 2 });
    expect(set).toHaveBeenCalledWith({ removedAt: expect.any(Date) });
  });

  it('reports only rows actually transitioned (already-removed rows excluded)', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    const ids = [randomUUID(), randomUUID()];
    mockUpdateReturning([{ id: ids[0]! }]);

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/remove',
      payload: { ids },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, removed: 1 });
  });

  it('rejects non-owners', async () => {
    app = await buildTestApp(createAuthUser('admin'));

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/remove',
      payload: { ids: [randomUUID()] },
    });

    expect(response.statusCode).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('rejects an empty ids array', async () => {
    app = await buildTestApp(createAuthUser('owner'));

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/remove',
      payload: { ids: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('rejects non-uuid ids', async () => {
    app = await buildTestApp(createAuthUser('owner'));

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/remove',
      payload: { ids: ['not-a-uuid'] },
    });

    expect(response.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
