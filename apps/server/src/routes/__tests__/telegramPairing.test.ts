/**
 * Telegram interactive pairing route tests.
 *
 * Model: routes/__tests__/ombi.test.ts (fake authenticate/requireOwner
 * decorators). The pairing service itself is mocked here - its own behavior
 * (rate limit, expiry, single-use, code matching) is covered by
 * services/__tests__/telegramPairing.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type * as TelegramPairingModule from '../../services/telegramPairing.js';

vi.mock('../../services/telegramPairing.js', async (importActual) => {
  const actual = await importActual<typeof TelegramPairingModule>();
  return {
    ...actual,
    startTelegramPairing: vi.fn(),
    getTelegramPairingStatus: vi.fn(),
    cancelTelegramPairing: vi.fn(),
  };
});

import {
  startTelegramPairing,
  getTelegramPairingStatus,
  cancelTelegramPairing,
  InvalidTelegramBotTokenError,
  TooManyPendingPairingsError,
  TelegramPairingRateLimitError,
} from '../../services/telegramPairing.js';
import { telegramPairingRoutes } from '../telegramPairing.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });

  await app.register(telegramPairingRoutes, { prefix: '/notifications' });
  return app;
}

function ownerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}
function viewerUser(): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds: [] };
}

const validStartResult = {
  pairingId: 'pairing-1',
  code: 'abc123',
  botUsername: 'MyTracearrBot',
  botLink: 'https://t.me/MyTracearrBot?start=abc123',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
};

describe('Telegram pairing routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('POST /notifications/telegram/pairing', () => {
    it('rejects non-owners', async () => {
      app = await buildTestApp(viewerUser());

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: '123456789:validlookingtoken' },
      });

      expect(response.statusCode).toBe(403);
      expect(startTelegramPairing).not.toHaveBeenCalled();
    });

    it('rejects an invalid request body', async () => {
      app = await buildTestApp(ownerUser());

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: 'not-a-real-token-shape' },
      });

      expect(response.statusCode).toBe(400);
      expect(startTelegramPairing).not.toHaveBeenCalled();
    });

    it('starts a pairing for a valid body and owner, never echoing the bot token', async () => {
      const owner = ownerUser();
      app = await buildTestApp(owner);
      vi.mocked(startTelegramPairing).mockResolvedValue(validStartResult);

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: '123456789:AAExampleTokenValueNotReal' },
      });

      expect(response.statusCode).toBe(200);
      expect(startTelegramPairing).toHaveBeenCalledWith(
        owner.userId,
        '123456789:AAExampleTokenValueNotReal'
      );
      const body = response.json();
      expect(body.pairingId).toBe('pairing-1');
      expect(body.botLink).toBe('https://t.me/MyTracearrBot?start=abc123');
      expect(JSON.stringify(body)).not.toContain('123456789:AAExampleTokenValueNotReal');
      expect(body).not.toHaveProperty('botToken');
    });

    it('returns 400 with a clear message for an invalid bot token', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(startTelegramPairing).mockRejectedValue(
        new InvalidTelegramBotTokenError('Could not verify this bot token with Telegram.')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: '123456789:AAExampleTokenValueNotReal' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Could not verify this bot token');
    });

    it('returns 400 when the max concurrent pending pairings is reached', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(startTelegramPairing).mockRejectedValue(
        new TooManyPendingPairingsError('Too many pending Telegram pairings.')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: '123456789:AAExampleTokenValueNotReal' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 429 with Retry-After when rate limited', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(startTelegramPairing).mockRejectedValue(new TelegramPairingRateLimitError(120));

      const response = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/pairing',
        payload: { botToken: '123456789:AAExampleTokenValueNotReal' },
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('120');
    });
  });

  describe('GET /notifications/telegram/pairing/:pairingId', () => {
    it('rejects non-owners', async () => {
      app = await buildTestApp(viewerUser());

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/telegram/pairing/some-id',
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for an unknown pairingId', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(getTelegramPairingStatus).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/telegram/pairing/unknown-id',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns the pairing status (pending)', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(getTelegramPairingStatus).mockReturnValue({ state: 'pending', chatId: null });

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/telegram/pairing/pairing-1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: 'pending', chatId: null });
    });

    it('returns the resolved chat id once paired', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(getTelegramPairingStatus).mockReturnValue({ state: 'paired', chatId: '555' });

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/telegram/pairing/pairing-1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: 'paired', chatId: '555' });
    });
  });

  describe('DELETE /notifications/telegram/pairing/:pairingId', () => {
    it('rejects non-owners', async () => {
      app = await buildTestApp(viewerUser());

      const response = await app.inject({
        method: 'DELETE',
        url: '/notifications/telegram/pairing/pairing-1',
      });

      expect(response.statusCode).toBe(403);
      expect(cancelTelegramPairing).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown pairingId', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(cancelTelegramPairing).mockReturnValue(false);

      const response = await app.inject({
        method: 'DELETE',
        url: '/notifications/telegram/pairing/unknown-id',
      });

      expect(response.statusCode).toBe(404);
    });

    it('cancels an existing pairing', async () => {
      app = await buildTestApp(ownerUser());
      vi.mocked(cancelTelegramPairing).mockReturnValue(true);

      const response = await app.inject({
        method: 'DELETE',
        url: '/notifications/telegram/pairing/pairing-1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(cancelTelegramPairing).toHaveBeenCalledWith('pairing-1');
    });
  });
});
