/**
 * Dashboard Statistics Route
 *
 * GET /dashboard - Dashboard summary metrics (active streams, plays, watch time, alerts)
 */

import type { FastifyPluginAsync } from 'fastify';
import { dashboardQuerySchema } from '@tracearr/shared';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { getDashboardStats } from '../../services/dashboardStats.js';

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /dashboard - Dashboard summary metrics
   *
   * Query params:
   * - serverId: Optional UUID to filter stats to a specific server
   * - serverIds: Optional array of UUIDs to filter stats
   * - timezone: Optional IANA timezone (default: UTC)
   */
  app.get('/dashboard', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = dashboardQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { serverId: legacyServerId, serverIds: rawServerIds, timezone } = query.data;
    const authUser = request.user;
    const tz = timezone ?? 'UTC';

    const resolvedIds = resolveServerIds(authUser, legacyServerId, rawServerIds, { strict: false });

    return getDashboardStats({
      serverIds: resolvedIds,
      timezone: tz,
      redis: app.redis,
    });
  });
};
