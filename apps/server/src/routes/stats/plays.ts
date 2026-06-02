/**
 * Play Statistics Routes
 *
 * GET /plays - Plays over time (engagement-based, >= 2 min sessions)
 * GET /plays-by-dayofweek - Plays grouped by day of week
 * GET /plays-by-hourofday - Plays grouped by hour of day
 *
 * All endpoints use engagement-based counting which filters out
 * sessions shorter than 2 minutes (Netflix-style "intent" threshold).
 */

import type { FastifyPluginAsync } from 'fastify';
import { statsQuerySchema } from '@tracearr/shared';
import { resolveDateRange } from './utils.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { queryPlaysOverTime, queryPlaysByDayOfWeek, queryPlaysByHourOfDay } from './queries.js';

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

export const playsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /plays - Plays over time (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by day.
   * Uses timezone-aware day bucketing so plays are grouped by user's local day.
   */
  app.get('/plays', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = buildMultiServerFragment(resolvedIds);
    const bucketInterval = getBucketInterval(period);
    const customEnd = period === 'custom' && dateRange.end ? dateRange.end : undefined;

    const data = await queryPlaysOverTime({
      rangeStart: dateRange.start,
      timezone: tz,
      bucketInterval,
      serverFilter,
      endDate: customEnd,
    });

    return { data };
  });

  /**
   * GET /plays-by-dayofweek - Plays grouped by day of week (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by day of week.
   */
  app.get('/plays-by-dayofweek', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = buildMultiServerFragment(resolvedIds);
    const customEnd = period === 'custom' ? dateRange.end : undefined;

    const data = await queryPlaysByDayOfWeek({
      rangeStart: dateRange.start,
      timezone: tz,
      serverFilter,
      endDate: customEnd,
    });

    return { data };
  });

  /**
   * GET /plays-by-hourofday - Plays grouped by hour of day (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by hour of day.
   * Queries sessions table directly with duration filter since engagement
   * view only has daily granularity.
   */
  app.get('/plays-by-hourofday', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = buildMultiServerFragment(resolvedIds);
    const customEnd = period === 'custom' ? dateRange.end : undefined;

    const data = await queryPlaysByHourOfDay({
      rangeStart: dateRange.start,
      timezone: tz,
      serverFilter,
      endDate: customEnd,
    });

    return { data };
  });
};
