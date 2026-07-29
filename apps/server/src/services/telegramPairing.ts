/**
 * Telegram interactive pairing.
 *
 * Lets an owner add the Telegram notification agent without already knowing
 * the chat id: POST validates the bot token against Telegram's getMe and
 * hands back a single-use pairing code + t.me deep link; the owner opens the
 * link (or pastes the code) in a chat with the bot; jobs/telegramCommandListener.ts
 * - the only thing allowed to long-poll that bot's getUpdates (Telegram
 * permits exactly one getUpdates consumer per bot) - watches for the code via
 * matchPairingCode() and records the resulting chat_id here. GET polls the
 * result; DELETE cancels.
 *
 * Storage: in-memory only (a plain Map), deliberately not Redis, for two
 * reasons. First, the server runs as a single process and the command
 * listener it depends on is itself in-memory (generation counter, per-chat
 * reply cooldown - see telegramCommandListener.ts) - a restart already drops
 * the live long-poll connection to Telegram, so persisting the pairing
 * session elsewhere would not let it survive a restart anyway. Second,
 * pairing sessions are short-lived (PAIRING_EXPIRY_MS) and single-use, so
 * there is nothing worth persisting across a restart: on restart, every
 * pending pairing is simply lost and the owner restarts the setup flow -
 * GET on a since-forgotten pairingId returns 404, which the frontend already
 * has to handle as "start over".
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  TelegramPairingState,
  TelegramPairingStart,
  TelegramPairingStatus,
} from '@tracearr/shared';
import { redactTelegramToken } from './telegramApi.js';

const TELEGRAM_API = 'https://api.telegram.org';
const GET_ME_TIMEOUT_MS = 10_000;

// How long a pairing has to be completed before it lazily flips to 'expired'.
const PAIRING_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
// Grace period an expired/paired record stays visible to GET after expiry,
// so a frontend poll in flight still gets a coherent answer, before it is
// hard-purged to bound memory.
const PAIRING_RETENTION_MS = 5 * 60 * 1000; // 5 minutes
// Bound against repeated POST calls building up unbounded pending sessions
// (each holds a live bot token in memory and cost a real Telegram API call
// to create).
const MAX_CONCURRENT_PENDING = 5;

// Rate limit on the start route: each call hits Telegram's getMe. Keyed by
// owner userId - cardinality is inherently tiny (this app has one owner
// account in practice), so no extra bound on the map itself is needed.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10;

export class InvalidTelegramBotTokenError extends Error {}
export class TooManyPendingPairingsError extends Error {}
export class TelegramPairingRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many pairing attempts. Please try again later.');
  }
}

interface PairingSession {
  pairingId: string;
  code: string;
  botToken: string;
  botUsername: string;
  chatId: string | null;
  state: TelegramPairingState;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, PairingSession>();
const rateLimits = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(
  userId: string,
  now: number
): { allowed: boolean; retryAfterSeconds: number } {
  const entry = rateLimits.get(userId);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(userId, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    };
  }
  entry.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Hard-purge sessions whose retention grace period has fully elapsed. */
function purgeStale(now: number): void {
  for (const [id, session] of sessions) {
    if (now > session.expiresAt + PAIRING_RETENTION_MS) {
      sessions.delete(id);
    }
  }
}

function countActivePending(now: number): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.state === 'pending' && now <= session.expiresAt) count++;
  }
  return count;
}

/** Validate a bot token against Telegram's getMe and return its @username, or null if invalid/unreachable. */
async function fetchBotUsername(botToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GET_ME_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`, {
      method: 'POST',
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { username?: string };
    } | null;
    if (!res.ok || !body?.ok || !body.result?.username) return null;
    return body.result.username;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return null;
    console.warn(
      '[TelegramPairing] getMe failed:',
      redactTelegramToken(botToken, String(err instanceof Error ? err.message : err))
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a pairing session: validates the token, then generates a single-use
 * code and t.me deep link. Throws InvalidTelegramBotTokenError,
 * TooManyPendingPairingsError, or TelegramPairingRateLimitError.
 */
export async function startTelegramPairing(
  userId: string,
  botToken: string
): Promise<TelegramPairingStart> {
  const now = Date.now();

  const rate = checkRateLimit(userId, now);
  if (!rate.allowed) throw new TelegramPairingRateLimitError(rate.retryAfterSeconds);

  purgeStale(now);
  if (countActivePending(now) >= MAX_CONCURRENT_PENDING) {
    throw new TooManyPendingPairingsError(
      'Too many pending Telegram pairings. Cancel one or wait for it to expire before starting another.'
    );
  }

  const botUsername = await fetchBotUsername(botToken);
  if (!botUsername) {
    throw new InvalidTelegramBotTokenError(
      'Could not verify this bot token with Telegram. Double-check it and try again.'
    );
  }

  const pairingId = randomUUID();
  const code = randomBytes(16).toString('hex'); // 128 bits - not guessable, embedded in the deep link
  const expiresAt = now + PAIRING_EXPIRY_MS;

  sessions.set(pairingId, {
    pairingId,
    code,
    botToken,
    botUsername,
    chatId: null,
    state: 'pending',
    createdAt: now,
    expiresAt,
  });

  return {
    pairingId,
    code,
    botUsername,
    botLink: `https://t.me/${botUsername}?start=${code}`,
    expiresAt: new Date(expiresAt),
  };
}

/** Poll a pairing's status. Returns null if the pairingId is unknown (never existed, or purged). */
export function getTelegramPairingStatus(pairingId: string): TelegramPairingStatus | null {
  const session = sessions.get(pairingId);
  if (!session) return null;

  if (session.state === 'pending' && Date.now() > session.expiresAt) {
    session.state = 'expired'; // lazy expiry - no timer needed
  }

  return { state: session.state, chatId: session.chatId };
}

/** Cancel a pairing session. Returns whether it existed. */
export function cancelTelegramPairing(pairingId: string): boolean {
  return sessions.delete(pairingId);
}

/**
 * Which bot token the command listener should long-poll this cycle. An
 * active (pending, unexpired) pairing takes priority over the saved config
 * token - the owner is actively trying to complete a new setup, which may be
 * for a different bot than whatever is (or isn't) already configured. Falls
 * back to the saved config token once no pairing is in flight. If more than
 * one pairing happens to be pending at once, the most recently started one
 * wins (only one bot can be polled at a time either way).
 */
export function resolvePollingToken(configToken: string | null): string | null {
  const now = Date.now();
  let newest: PairingSession | null = null;
  for (const session of sessions.values()) {
    if (session.state !== 'pending' || now > session.expiresAt) continue;
    if (!newest || session.createdAt > newest.createdAt) newest = session;
  }
  return newest?.botToken ?? configToken;
}

export interface PairingMatchResult {
  chatId: number;
  text: string;
}

/**
 * Check an incoming Telegram update against every active pairing code. On a
 * match, records the chat_id, marks the session 'paired' (consuming the code
 * - one successful pairing only), and returns a confirmation reply.
 *
 * The code is compared in full against whole "words" of the message text
 * (splitting on whitespace) - never a prefix or a raw substring search - so
 * this covers both a bare pasted code and Telegram's own "/start <code>"
 * deep-link message, without ever accepting a partial/guessable match.
 */
export function matchPairingCode(update: {
  message?: { text?: string; chat?: { id: number } };
}): PairingMatchResult | null {
  const text = update.message?.text?.trim();
  const chatId = update.message?.chat?.id;
  if (!text || typeof chatId !== 'number') return null;

  const now = Date.now();
  const words = text.split(/\s+/);

  for (const session of sessions.values()) {
    if (session.state !== 'pending' || now > session.expiresAt) continue;
    if (text !== session.code && !words.includes(session.code)) continue;

    session.chatId = String(chatId);
    session.state = 'paired';
    return {
      chatId,
      text:
        'Telegram is now paired with Tracearr.\n\n' +
        `Chat ID: ${chatId}\n\n` +
        'Return to Tracearr to finish adding the agent.',
    };
  }

  return null;
}

/** Test hook: clear all pairing/rate-limit state between tests. */
export function _resetTelegramPairingForTests(): void {
  sessions.clear();
  rateLimits.clear();
}

// Exposed for tests only - not part of the public service surface.
export const _internal = {
  PAIRING_EXPIRY_MS,
  PAIRING_RETENTION_MS,
  MAX_CONCURRENT_PENDING,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
};
