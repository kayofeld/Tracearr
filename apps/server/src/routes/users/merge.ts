/**
 * User Merge Routes
 *
 * POST /:id/merge          - Merge the source identity :id into body.targetUserId
 * GET  /merge-suggestions  - Possible duplicate identities across servers
 *
 * IMPORTANT: :id here is a users.id (identity). Sibling routes in this
 * directory use server_users ids. The web client passes row.userId.
 * Owner only. Same-server combines are destructive and are refused with
 * 409 until confirmSameServerCombine is sent.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  mergeUsersBodySchema,
  mergeUserParamSchema,
  MERGE_SAME_SERVER_CONFIRMATION_REQUIRED,
} from '@tracearr/shared';
import {
  mergeUsers,
  getMergeSuggestions,
  MergeValidationError,
  SameServerCombineNotConfirmedError,
} from '../../services/mergeService.js';
import { UserNotFoundError } from '../../services/userService.js';

export const mergeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/merge-suggestions', { preHandler: [app.requireOwner] }, async () => {
    const data = await getMergeSuggestions();
    return { data };
  });

  app.post('/:id/merge', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const params = mergeUserParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }
    const body = mergeUsersBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    try {
      return await mergeUsers(params.data.id, body.data.targetUserId, request.user.userId, {
        confirmSameServerCombine: body.data.confirmSameServerCombine,
      });
    } catch (error) {
      if (error instanceof SameServerCombineNotConfirmedError) {
        return reply.conflict(MERGE_SAME_SERVER_CONFIRMATION_REQUIRED);
      }
      if (error instanceof MergeValidationError) {
        return reply.badRequest(error.message);
      }
      if (error instanceof UserNotFoundError) {
        return reply.notFound(error.message);
      }
      throw error;
    }
  });
};
