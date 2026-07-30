/**
 * Authorization tests for the played-state routes (contract §7.1; review
 * finding F1 fix).
 *
 * The F1 rule under guard: a scoped admin POSTing a serverId outside their
 * scope must receive a response INDISTINGUISHABLE from the one for a server id
 * that does not exist at all - no existence or type oracle - and the
 * access check must run BEFORE the existence lookup so the database is never
 * consulted for an inaccessible id. Sync-all (no serverId) is owner-only.
 *
 * Uses the REAL serverFiltering utilities (they are pure); only the queue and
 * the status reader are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

const mockEnqueue = vi.fn();
const mockGetServer = vi.fn();
const mockStatusResponse = vi.fn();

vi.mock('../../../jobs/playedStateSyncQueue.js', () => ({
  enqueuePlayedStateSync: (...args: unknown[]) => mockEnqueue(...args),
  getServerForPlayedStateSync: (...args: unknown[]) => mockGetServer(...args),
}));

vi.mock('../../../services/playedStateSync.js', () => ({
  getPlayedStateSyncStatusResponse: (...args: unknown[]) => mockStatusResponse(...args),
}));

import { libraryPlayedStateRoute } from '../playedState.js';

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  await app.register(libraryPlayedStateRoute, { prefix: '/library' });
  return app;
}

const accessibleId = randomUUID();
const inaccessibleButExistingId = randomUUID();
const unknownId = randomUUID();

function scopedAdmin(): AuthUser {
  return { userId: randomUUID(), username: 'admin', role: 'admin', serverIds: [accessibleId] };
}

function owner(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function viewer(): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds: [accessibleId] };
}

describe('POST /library/played-state/sync', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueue.mockResolvedValue('job-1');
    // The DB knows accessibleId (emby) and inaccessibleButExistingId (emby);
    // unknownId resolves to nothing.
    mockGetServer.mockImplementation((serverId: string) => {
      if (serverId === accessibleId || serverId === inaccessibleButExistingId) {
        return Promise.resolve({ id: serverId, type: 'emby' });
      }
      return Promise.resolve(null);
    });
    mockStatusResponse.mockResolvedValue({ servers: [] });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns byte-identical responses to a scoped admin for an inaccessible-but-existing server and an unknown one (no existence oracle)', async () => {
    app = await buildApp(scopedAdmin());

    const inaccessible = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: inaccessibleButExistingId },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: unknownId },
    });

    expect(inaccessible.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    // The two bodies must be indistinguishable - any difference is an oracle.
    expect(inaccessible.json()).toEqual(unknown.json());
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('never performs the existence lookup for an inaccessible server (access checked first)', async () => {
    app = await buildApp(scopedAdmin());

    await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: inaccessibleButExistingId },
    });

    expect(mockGetServer).not.toHaveBeenCalled();
  });

  it('does not leak the server TYPE through the reply: an inaccessible Plex server gets the generic 400, not the Plex message', async () => {
    mockGetServer.mockResolvedValue({ id: inaccessibleButExistingId, type: 'plex' });
    app = await buildApp(scopedAdmin());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: inaccessibleButExistingId },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toMatch(/plex/i);
  });

  it('allows a scoped admin to sync a server they DO have access to', async () => {
    app = await buildApp(scopedAdmin());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: accessibleId },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: 'job-1' });
    expect(mockEnqueue).toHaveBeenCalledWith(accessibleId, expect.any(String));
  });

  it('rejects sync-all (no serverId) from a scoped admin with 403 - owner-only', async () => {
    app = await buildApp(scopedAdmin());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('allows sync-all for the owner', async () => {
    app = await buildApp(owner());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  it('rejects any trigger from a viewer with 403', async () => {
    app = await buildApp(viewer());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: accessibleId },
    });

    expect(response.statusCode).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns 400 with the Plex message for the OWNER naming a Plex server (type visible only inside the access scope)', async () => {
    mockGetServer.mockResolvedValue({ id: unknownId, type: 'plex' });
    app = await buildApp(owner());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: unknownId },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/plex/i);
  });

  it('maps an already-running enqueue rejection to 409', async () => {
    mockEnqueue.mockRejectedValue(
      new Error('Played-state sync already in progress for this server')
    );
    app = await buildApp(owner());

    const response = await app.inject({
      method: 'POST',
      url: '/library/played-state/sync',
      payload: { serverId: accessibleId },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('GET /library/played-state/status', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusResponse.mockResolvedValue({ servers: [] });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("scopes the status query to a non-owner's accessible servers", async () => {
    app = await buildApp(scopedAdmin());

    const response = await app.inject({ method: 'GET', url: '/library/played-state/status' });

    expect(response.statusCode).toBe(200);
    expect(mockStatusResponse).toHaveBeenCalledWith([accessibleId]);
  });

  it('passes undefined (all servers) for the owner', async () => {
    app = await buildApp(owner());

    const response = await app.inject({ method: 'GET', url: '/library/played-state/status' });

    expect(response.statusCode).toBe(200);
    expect(mockStatusResponse).toHaveBeenCalledWith(undefined);
  });
});
