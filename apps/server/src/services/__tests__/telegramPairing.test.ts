/**
 * Telegram interactive pairing service tests.
 *
 * No live Telegram: every getMe call goes through a mocked global fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startTelegramPairing,
  getTelegramPairingStatus,
  cancelTelegramPairing,
  matchPairingCode,
  resolvePollingToken,
  InvalidTelegramBotTokenError,
  TooManyPendingPairingsError,
  TelegramPairingRateLimitError,
  _resetTelegramPairingForTests,
  _internal,
} from '../telegramPairing.js';

const OWNER_ID = 'owner-1';
const BOT_TOKEN = '123456789:AAExampleTokenValueNotReal';

function mockGetMeOk(username = 'MyTracearrBot'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 1, username } }),
    })
  );
}

function mockGetMeInvalid(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })
  );
}

function mockGetMeThrows(message: string): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)));
}

describe('telegramPairing service', () => {
  beforeEach(() => {
    _resetTelegramPairingForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('startTelegramPairing', () => {
    it('rejects an invalid bot token before the owner ever goes to Telegram', async () => {
      mockGetMeInvalid();

      await expect(startTelegramPairing(OWNER_ID, BOT_TOKEN)).rejects.toBeInstanceOf(
        InvalidTelegramBotTokenError
      );
    });

    it('returns pairingId, code, botUsername, botLink and expiresAt for a valid token', async () => {
      mockGetMeOk('MyTracearrBot');

      const result = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      expect(result.pairingId).toEqual(expect.any(String));
      expect(result.code).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
      expect(result.botUsername).toBe('MyTracearrBot');
      expect(result.botLink).toBe(`https://t.me/MyTracearrBot?start=${result.code}`);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('never includes the bot token anywhere in the response', async () => {
      mockGetMeOk();

      const result = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(BOT_TOKEN);
      expect(result).not.toHaveProperty('botToken');
    });

    it('never leaks the bot token into a log line when getMe errors', async () => {
      mockGetMeThrows(`fetch failed: https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(startTelegramPairing(OWNER_ID, BOT_TOKEN)).rejects.toBeInstanceOf(
        InvalidTelegramBotTokenError
      );

      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(BOT_TOKEN);
        }
      }
      warnSpy.mockRestore();
    });

    it('rate limits repeated start attempts for the same owner', async () => {
      mockGetMeOk();

      // Consume each pairing right after creating it, so only the per-owner
      // rate limit is exercised - not the separate max-concurrent-pending bound.
      for (let i = 0; i < _internal.RATE_LIMIT_MAX_ATTEMPTS; i++) {
        const { code } = await startTelegramPairing(OWNER_ID, `${BOT_TOKEN}${i}`);
        matchPairingCode({ message: { text: code, chat: { id: i } } });
      }

      await expect(startTelegramPairing(OWNER_ID, `${BOT_TOKEN}-over`)).rejects.toBeInstanceOf(
        TelegramPairingRateLimitError
      );
    });

    it('reports a positive retryAfterSeconds once rate limited', async () => {
      mockGetMeOk();
      for (let i = 0; i < _internal.RATE_LIMIT_MAX_ATTEMPTS; i++) {
        const { code } = await startTelegramPairing(OWNER_ID, `${BOT_TOKEN}${i}`);
        matchPairingCode({ message: { text: code, chat: { id: i } } });
      }

      try {
        await startTelegramPairing(OWNER_ID, `${BOT_TOKEN}-over`);
        expect.unreachable('expected rate limit error');
      } catch (err) {
        expect(err).toBeInstanceOf(TelegramPairingRateLimitError);
        expect((err as TelegramPairingRateLimitError).retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('bounds the number of concurrent pending pairings', async () => {
      mockGetMeOk();

      // Use distinct owner ids so only the pending-count bound is exercised,
      // not the per-owner rate limit.
      for (let i = 0; i < _internal.MAX_CONCURRENT_PENDING; i++) {
        await startTelegramPairing(`owner-${i}`, `${BOT_TOKEN}${i}`);
      }

      await expect(
        startTelegramPairing('owner-overflow', `${BOT_TOKEN}-overflow`)
      ).rejects.toBeInstanceOf(TooManyPendingPairingsError);
    });
  });

  describe('getTelegramPairingStatus', () => {
    it('returns null for an unknown pairingId', () => {
      expect(getTelegramPairingStatus('does-not-exist')).toBeNull();
    });

    it('returns pending immediately after start', async () => {
      mockGetMeOk();
      const { pairingId } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      expect(getTelegramPairingStatus(pairingId)).toEqual({ state: 'pending', chatId: null });
    });

    it('lazily expires a pending pairing once past expiresAt', async () => {
      vi.useFakeTimers();
      mockGetMeOk();
      const { pairingId } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      vi.advanceTimersByTime(_internal.PAIRING_EXPIRY_MS + 1);

      expect(getTelegramPairingStatus(pairingId)).toEqual({ state: 'expired', chatId: null });
    });
  });

  describe('cancelTelegramPairing', () => {
    it('removes an existing pairing and reports it existed', async () => {
      mockGetMeOk();
      const { pairingId } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      expect(cancelTelegramPairing(pairingId)).toBe(true);
      expect(getTelegramPairingStatus(pairingId)).toBeNull();
    });

    it('reports false for an unknown pairingId', () => {
      expect(cancelTelegramPairing('does-not-exist')).toBe(false);
    });
  });

  describe('matchPairingCode (the listener message-handling path)', () => {
    it('pairs successfully end to end: start -> deep-link message -> paired status with chat id', async () => {
      mockGetMeOk();
      const { pairingId, code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      // This is exactly the message text Telegram sends when a user opens a
      // t.me/<bot>?start=<code> deep link.
      const update = { message: { text: `/start ${code}`, chat: { id: 555 } } };
      const match = matchPairingCode(update);

      expect(match).not.toBeNull();
      expect(match?.chatId).toBe(555);
      expect(match?.text).toContain('555');

      expect(getTelegramPairingStatus(pairingId)).toEqual({ state: 'paired', chatId: '555' });
    });

    it('also matches a bare pasted code (no /start prefix)', async () => {
      mockGetMeOk();
      const { pairingId, code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      const match = matchPairingCode({ message: { text: code, chat: { id: 777 } } });

      expect(match?.chatId).toBe(777);
      expect(getTelegramPairingStatus(pairingId)?.state).toBe('paired');
    });

    it('does not pair on a wrong code', async () => {
      mockGetMeOk();
      const { pairingId } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      const match = matchPairingCode({
        message: { text: '/start deadbeefdeadbeefdeadbeefdead', chat: { id: 999 } },
      });

      expect(match).toBeNull();
      expect(getTelegramPairingStatus(pairingId)).toEqual({ state: 'pending', chatId: null });
    });

    it('does not accept a prefix of the code as a match', async () => {
      mockGetMeOk();
      const { pairingId, code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);
      const prefix = code.slice(0, 8);

      const match = matchPairingCode({ message: { text: `/start ${prefix}`, chat: { id: 111 } } });

      expect(match).toBeNull();
      expect(getTelegramPairingStatus(pairingId)?.state).toBe('pending');
    });

    it('enforces single use: a second attempt after pairing does not re-pair or overwrite the chat id', async () => {
      mockGetMeOk();
      const { pairingId, code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      const first = matchPairingCode({ message: { text: `/start ${code}`, chat: { id: 555 } } });
      expect(first?.chatId).toBe(555);

      // A second message with the same code, from a different chat, must not
      // re-pair or clobber the already-recorded chat id.
      const second = matchPairingCode({ message: { text: `/start ${code}`, chat: { id: 666 } } });
      expect(second).toBeNull();

      expect(getTelegramPairingStatus(pairingId)).toEqual({ state: 'paired', chatId: '555' });
    });

    it('does not match a code that has already expired', async () => {
      vi.useFakeTimers();
      mockGetMeOk();
      const { code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      vi.advanceTimersByTime(_internal.PAIRING_EXPIRY_MS + 1);

      const match = matchPairingCode({ message: { text: `/start ${code}`, chat: { id: 555 } } });
      expect(match).toBeNull();
    });

    it('ignores a message with no text or no chat id', () => {
      expect(matchPairingCode({ message: {} })).toBeNull();
      expect(matchPairingCode({})).toBeNull();
    });
  });

  describe('resolvePollingToken', () => {
    it('falls back to the config token when no pairing is in flight', () => {
      expect(resolvePollingToken('configured-token')).toBe('configured-token');
      expect(resolvePollingToken(null)).toBeNull();
    });

    it('prioritizes an active pending pairing over the config token', async () => {
      mockGetMeOk();
      await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      expect(resolvePollingToken('configured-token')).toBe(BOT_TOKEN);
    });

    it('falls back to config once the pairing is paired (no longer pending)', async () => {
      mockGetMeOk();
      const { code } = await startTelegramPairing(OWNER_ID, BOT_TOKEN);
      matchPairingCode({ message: { text: code, chat: { id: 1 } } });

      expect(resolvePollingToken('configured-token')).toBe('configured-token');
    });

    it('falls back to config once the pairing has expired', async () => {
      vi.useFakeTimers();
      mockGetMeOk();
      await startTelegramPairing(OWNER_ID, BOT_TOKEN);

      vi.advanceTimersByTime(_internal.PAIRING_EXPIRY_MS + 1);

      expect(resolvePollingToken('configured-token')).toBe('configured-token');
    });

    it('picks the most recently started pairing when more than one is pending', async () => {
      vi.useFakeTimers();
      mockGetMeOk();
      await startTelegramPairing('owner-a', `${BOT_TOKEN}-a`);
      vi.advanceTimersByTime(5);
      await startTelegramPairing('owner-b', `${BOT_TOKEN}-b`);

      expect(resolvePollingToken(null)).toBe(`${BOT_TOKEN}-b`);
    });
  });
});
