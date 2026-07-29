/**
 * Telegram interactive pairing routes - resolves a bot token to its chat id
 * without requiring the owner to already know the chat id up front.
 *
 * Flow: POST validates the bot token (Telegram getMe) and returns a
 * single-use pairing code + t.me deep link; the owner opens the link (or
 * pastes the code) in a chat with the bot; jobs/telegramCommandListener.ts -
 * the only thing allowed to long-poll that bot's getUpdates - watches for the
 * code and records the resulting chat_id (services/telegramPairing.ts). GET
 * polls the result; DELETE cancels. The frontend then creates the agent with
 * the token + resolved chat id through the existing settings save path - this
 * route group only resolves the chat id, it never stores the agent itself.
 *
 * Owner-only, like the other notification settings routes (routes/settings.ts).
 */

import type { FastifyPluginAsync } from 'fastify';
import { telegramPairingStartSchema } from '@tracearr/shared';
import {
  startTelegramPairing,
  getTelegramPairingStatus,
  cancelTelegramPairing,
  InvalidTelegramBotTokenError,
  TooManyPendingPairingsError,
  TelegramPairingRateLimitError,
} from '../services/telegramPairing.js';

export const telegramPairingRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /notifications/telegram/pairing - validate the bot token and start a pairing session
   */
  app.post('/telegram/pairing', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = telegramPairingStartSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    try {
      return await startTelegramPairing(request.user.userId, body.data.botToken);
    } catch (err) {
      if (err instanceof TelegramPairingRateLimitError) {
        reply.header('Retry-After', String(err.retryAfterSeconds));
        return reply.tooManyRequests(err.message);
      }
      if (
        err instanceof TooManyPendingPairingsError ||
        err instanceof InvalidTelegramBotTokenError
      ) {
        return reply.badRequest(err.message);
      }
      throw err;
    }
  });

  /**
   * GET /notifications/telegram/pairing/:pairingId - poll pairing status
   */
  app.get<{ Params: { pairingId: string } }>(
    '/telegram/pairing/:pairingId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const status = getTelegramPairingStatus(request.params.pairingId);
      if (!status) {
        return reply.notFound('Pairing session not found');
      }
      return status;
    }
  );

  /**
   * DELETE /notifications/telegram/pairing/:pairingId - cancel a pairing session
   */
  app.delete<{ Params: { pairingId: string } }>(
    '/telegram/pairing/:pairingId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const existed = cancelTelegramPairing(request.params.pairingId);
      if (!existed) {
        return reply.notFound('Pairing session not found');
      }
      return { success: true };
    }
  );
};
