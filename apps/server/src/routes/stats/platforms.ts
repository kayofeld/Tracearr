/**
 * Platform Statistics Route
 *
 * GET /platforms - Plays by platform
 * Uses prepared statement for 10-30% query plan reuse speedup (when no server filter)
 */

import type { FastifyPluginAsync } from 'fastify';
import { statsQuerySchema } from '@tracearr/shared';
import { playsByPlatformSince } from '../../db/prepared.js';
import { resolveDateRange } from './utils.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { queryPlatforms } from './queries.js';

export const platformsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /platforms - Plays by platform
   * Uses prepared statement for better performance when no server filter
   */
  app.get('/platforms', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = buildMultiServerFragment(resolvedIds);
    const needsServerFilter = resolvedIds !== undefined;

    // For 'all' period (no start date) OR when server filtering is needed, use shared query
    // Prepared statements don't support dynamic server filtering
    if (!dateRange.start || needsServerFilter) {
      const data = await queryPlatforms({ rangeStart: dateRange.start, serverFilter });
      return { data };
    }

    // No server filter needed and has date range - use prepared statement for performance
    const platformStats = await playsByPlatformSince.execute({ since: dateRange.start });
    return { data: platformStats };
  });
};
