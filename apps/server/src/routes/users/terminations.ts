/**
 * User Terminations Route
 *
 * GET /:id/terminations - Get termination history for a user
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { userIdParamSchema, identityScopedPaginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { terminationLogs, users, rules, sessions, servers } from '../../db/schema.js';
import { resolveIdentityScopedServerUserIds } from './queries.js';

export const terminationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/terminations - Get termination history for a user
   *
   * Returns all stream terminations where this user's streams were killed,
   * including who triggered it (manual) or which rule (automated).
   * scope=identity expands the result to every account under the same
   * person that the caller can access.
   */
  app.get('/:id/terminations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopedPaginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page, pageSize, scope } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const scoped = await resolveIdentityScopedServerUserIds(db, authUser, id, scope);
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    const ids = scoped.ids;

    // Get termination logs with joined data
    const terminations = await db
      .select({
        id: terminationLogs.id,
        sessionId: terminationLogs.sessionId,
        serverId: terminationLogs.serverId,
        serverName: servers.name,
        serverUserId: terminationLogs.serverUserId,
        trigger: terminationLogs.trigger,
        triggeredByUserId: terminationLogs.triggeredByUserId,
        triggeredByUsername: users.username,
        ruleId: terminationLogs.ruleId,
        ruleName: rules.name,
        violationId: terminationLogs.violationId,
        reason: terminationLogs.reason,
        success: terminationLogs.success,
        errorMessage: terminationLogs.errorMessage,
        createdAt: terminationLogs.createdAt,
        // Session info
        mediaTitle: sessions.mediaTitle,
        mediaType: sessions.mediaType,
        grandparentTitle: sessions.grandparentTitle,
        seasonNumber: sessions.seasonNumber,
        episodeNumber: sessions.episodeNumber,
        year: sessions.year,
        artistName: sessions.artistName,
        albumName: sessions.albumName,
      })
      .from(terminationLogs)
      .leftJoin(users, eq(terminationLogs.triggeredByUserId, users.id))
      .leftJoin(rules, eq(terminationLogs.ruleId, rules.id))
      .leftJoin(sessions, eq(terminationLogs.sessionId, sessions.id))
      .leftJoin(servers, eq(terminationLogs.serverId, servers.id))
      .where(inArray(terminationLogs.serverUserId, ids))
      .orderBy(desc(terminationLogs.createdAt))
      .limit(pageSize)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(terminationLogs)
      .where(inArray(terminationLogs.serverUserId, ids));

    const total = countResult[0]?.count ?? 0;

    return {
      data: terminations,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });
};
