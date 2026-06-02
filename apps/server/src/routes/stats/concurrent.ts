/**
 * Concurrent Streams Statistics Route
 *
 * GET /concurrent - Concurrent stream history
 */

import type { FastifyPluginAsync } from 'fastify';
import { statsQuerySchema } from '@tracearr/shared';
import { resolveDateRange } from './utils.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { queryConcurrentStreams } from './queries.js';

/**
 * Get bucket interval based on the requested period.
 * Returns interval string for TimescaleDB time_bucket().
 */
function getBucketInterval(period: string): string {
  switch (period) {
    case 'day':
      return '1 hour';
    case 'week':
      return '6 hours';
    case 'month':
    case 'year':
      return '1 day';
    case 'all':
    default:
      return '1 week';
  }
}

export const concurrentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /concurrent - Concurrent stream history (true concurrency)
   *
   * Uses an event-based algorithm: treats each session start as +1 and stop as -1,
   * calculates running totals, then finds peak per time bucket.
   * This scans the sessions table once instead of per-sample-point.
   */
  app.get('/concurrent', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = buildMultiServerFragment(resolvedIds);
    const bucketInterval = getBucketInterval(period);
    const rangeStart = dateRange.start ?? new Date(0);
    const rangeEnd = dateRange.end ?? new Date();

    const data = await queryConcurrentStreams({
      rangeStart,
      rangeEnd,
      bucketInterval,
      serverFilter,
    });

    return { data };
  });
};
