/**
 * Quality Statistics Route
 *
 * GET /quality - Direct play / direct stream / transcode breakdown
 * Uses prepared statement for 10-30% query plan reuse speedup (when no server filter)
 */

import type { FastifyPluginAsync } from 'fastify';
import { statsQuerySchema } from '@tracearr/shared';
import { qualityStatsSince } from '../../db/prepared.js';
import { resolveDateRange } from './utils.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { queryQualityBreakdown, computeQualityBreakdown } from './queries.js';

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Direct play / direct stream / transcode breakdown
   * Uses prepared statement for better performance when no server filter
   */
  app.get('/quality', { preHandler: [app.authenticate] }, async (request, reply) => {
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
      return queryQualityBreakdown({ rangeStart: dateRange.start, serverFilter });
    }

    // No server filter needed and has date range - use prepared statement for performance
    const qualityStats = await qualityStatsSince.execute({ since: dateRange.start });
    return computeQualityBreakdown(qualityStats);
  });
};
