/**
 * Played-State Sync Routes (contract: docs/architecture/emby-played-state-sync.md §7.1)
 *
 * - GET /played-state/status - per-server sync status + coverage, any logged-in role
 *   (server list filtered by resolveServerIds access, like other library routes).
 * - POST /played-state/sync - owner/admin only manual trigger.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  playedStateSyncTriggerSchema,
  type PlayedStateSyncTriggerResponse,
} from '@tracearr/shared';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import {
  enqueuePlayedStateSync,
  getServerForPlayedStateSync,
} from '../../jobs/playedStateSyncQueue.js';
import { getPlayedStateSyncStatusResponse } from '../../services/playedStateSync.js';

export const libraryPlayedStateRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /played-state/status - per-server played-state sync status + coverage.
   */
  app.get('/played-state/status', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    // No serverId/serverIds query param in the contract (§7.1) - just the
    // caller's accessible server scope, same access semantics as other
    // library routes (owner: all servers, others: their own serverIds).
    const resolvedIds = resolveServerIds(authUser, undefined, undefined);

    return getPlayedStateSyncStatusResponse(resolvedIds);
  });

  /**
   * POST /played-state/sync - manual sync trigger. owner/admin only.
   * 202 { jobId } enqueued / 409 already running / 400 Plex or unknown serverId.
   */
  app.post('/played-state/sync', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner' && authUser.role !== 'admin') {
      return reply.forbidden('Owner or admin access required');
    }

    const body = playedStateSyncTriggerSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { serverId } = body.data;

    if (serverId) {
      const server = await getServerForPlayedStateSync(serverId);
      if (!server) {
        return reply.badRequest('Unknown server');
      }
      if (server.type === 'plex') {
        return reply.badRequest('Plex does not support played-state sync');
      }
    }

    try {
      const jobId = await enqueuePlayedStateSync(serverId, authUser.userId);
      return await reply.code(202).send({ jobId } satisfies PlayedStateSyncTriggerResponse);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to enqueue played-state sync';
      if (message.includes('already in progress')) {
        return reply.conflict(message);
      }
      app.log.error({ err: error }, 'Failed to enqueue played-state sync');
      return reply.internalServerError(message);
    }
  });
};
