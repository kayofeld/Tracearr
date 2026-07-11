/**
 * User merge routes tests
 *
 * POST /users/:id/merge and GET /users/merge-suggestions with the
 * merge service mocked. NOTE: in these routes :id is the source
 * users.id (identity), unlike sibling user routes where :id is a
 * server_users id.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { MERGE_SAME_SERVER_CONFIRMATION_REQUIRED } from '@tracearr/shared';
import type * as MergeServiceModule from '../../../services/mergeService.js';

vi.mock('../../../services/mergeService.js', async (importActual) => {
  const actual = await importActual<typeof MergeServiceModule>();
  return {
    ...actual,
    mergeUsers: vi.fn(),
    getMergeSuggestions: vi.fn(),
  };
});

import {
  mergeUsers,
  getMergeSuggestions,
  MergeDirectionError,
  SameServerCombineNotConfirmedError,
} from '../../../services/mergeService.js';
import { mergeRoutes } from '../merge.js';

const mockMergeUsers = vi.mocked(mergeUsers);
const mockGetMergeSuggestions = vi.mocked(getMergeSuggestions);

function createAuthUser(role: AuthUser['role']): AuthUser {
  return { userId: randomUUID(), username: 'tester', role, serverIds: [] };
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });
  await app.register(mergeRoutes, { prefix: '/users' });
  return app;
}

describe('merge routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('merges and returns the result for an owner', async () => {
    const owner = createAuthUser('owner');
    app = await buildTestApp(owner);
    const sourceId = randomUUID();
    const targetId = randomUUID();
    mockMergeUsers.mockResolvedValue({
      targetUserId: targetId,
      auditId: randomUUID(),
      movedServerUserIds: [randomUUID()],
      combinedServerUsers: [],
      wasSameServerCombine: false,
      droppedRuleNames: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/users/${sourceId}/merge`,
      payload: { targetUserId: targetId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().targetUserId).toBe(targetId);
    expect(mockMergeUsers).toHaveBeenCalledWith(sourceId, targetId, owner.userId, {
      confirmSameServerCombine: false,
    });
  });

  it('returns 409 with the shared sentinel when confirmation is required', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockMergeUsers.mockRejectedValue(new SameServerCombineNotConfirmedError('needs confirmation'));

    const response = await app.inject({
      method: 'POST',
      url: `/users/${randomUUID()}/merge`,
      payload: { targetUserId: randomUUID() },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe(MERGE_SAME_SERVER_CONFIRMATION_REQUIRED);
  });

  it('returns 400 when the direction rule rejects the merge', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockMergeUsers.mockRejectedValue(new MergeDirectionError('login-capable source'));

    const response = await app.inject({
      method: 'POST',
      url: `/users/${randomUUID()}/merge`,
      payload: { targetUserId: randomUUID() },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects non-owners', async () => {
    app = await buildTestApp(createAuthUser('viewer'));

    const response = await app.inject({
      method: 'POST',
      url: `/users/${randomUUID()}/merge`,
      payload: { targetUserId: randomUUID() },
    });

    expect(response.statusCode).toBe(403);
    expect(mockMergeUsers).not.toHaveBeenCalled();
  });

  it('rejects an invalid body', async () => {
    app = await buildTestApp(createAuthUser('owner'));

    const response = await app.inject({
      method: 'POST',
      url: `/users/${randomUUID()}/merge`,
      payload: { targetUserId: 'not-a-uuid' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns suggestions for an owner', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockGetMergeSuggestions.mockResolvedValue([]);

    const response = await app.inject({ method: 'GET', url: '/users/merge-suggestions' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });
});
