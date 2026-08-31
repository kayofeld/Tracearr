/**
 * Telegram command listener.
 *
 * Long-polls the Bot API (getUpdates) and answers /start and /chatid with the
 * sender's chat ID, so a user can obtain the ID to paste into the Telegram
 * notification settings without hunting for it. Runs only when a bot token is
 * configured; the token is read fresh each cycle, so adding/changing it later
 * takes effect without a restart.
 *
 * Also watches every update for an active interactive-pairing code (see
 * services/telegramPairing.ts) - Telegram allows exactly one getUpdates
 * consumer per bot, so the pairing flow cannot run its own poller and instead
 * piggybacks on this one. While a pairing is in flight (no agent saved yet,
 * or the owner is replacing the configured bot), resolvePollingToken() makes
 * this loop poll the pairing's bot token instead of - or in addition to
 * falling back to - the saved config token.
 *
 * Single loop at a time: each start()/stop() bumps a generation counter and
 * aborts the in-flight fetch/sleep, so the previous loop exits promptly and a
 * stop->start (e.g. maintenance recovery) can never leave two loops polling the
 * same token (which Telegram answers with 409 conflicts).
 */

import { matchPairingCode, resolvePollingToken } from '../services/telegramPairing.js';
import { redactTelegramToken } from '../services/telegramApi.js';
import { listDestinations, readConfig } from '../services/notifications/destinationStore.js';

/**
 * The bot token used to live in settings as plaintext. Upstream replaced the
 * per-channel settings columns with `destinations`, whose config is AES-GCM
 * encrypted, so the token is read from the Telegram destination instead - the
 * same value the destination delivers with, and no second copy to keep in sync.
 *
 * Returns null when no Telegram destination is configured (or its config will
 * not decrypt), which the caller treats as "nothing to poll".
 */
async function readTelegramBotToken(): Promise<string | null> {
  for (const row of await listDestinations()) {
    if (row.type !== 'telegram') continue;
    const result = readConfig(row);
    if (!result.ok) continue;
    const token = result.config.botToken;
    if (typeof token === 'string' && token !== '') return token;
  }
  return null;
}

const API = 'https://api.telegram.org';
const LONG_POLL_SECONDS = 30;
const IDLE_MS = 30_000; // no token / error backoff
const REPLY_COOLDOWN_MS = 60_000; // per-chat, so a public-bot flood can't drain the shared send budget
const COOLDOWN_MAX = 1000; // cap the cooldown map so a flood of distinct chats can't grow it unbounded

interface TgChat {
  id: number;
}
interface TgMessage {
  text?: string;
  chat?: TgChat;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** The reply for a command update, or null if the update isn't a handled command. */
export function chatIdReplyFor(update: TgUpdate): { chatId: number; text: string } | null {
  const text = update.message?.text?.trim();
  const chatId = update.message?.chat?.id;
  if (!text || typeof chatId !== 'number') return null;
  // First token, stripped of a @BotName suffix that Telegram adds in groups.
  const cmd = (text.split(/[\s@]/)[0] ?? '').toLowerCase();
  if (cmd !== '/start' && cmd !== '/chatid') return null;
  return {
    chatId,
    text:
      `Your Telegram chat ID is: ${chatId}\n\n` +
      'Paste this into Tracearr under Settings → Notifications → Telegram.',
  };
}

// chatId -> last reply epoch ms. Bounded by COOLDOWN_MAX (oldest-inserted evicted).
const replyCooldown = new Map<number, number>();

/** Rate-limit replies per chat so the public bot can't be used to drain the token's send budget. */
export function allowReply(chatId: number, now = Date.now()): boolean {
  const last = replyCooldown.get(chatId);
  if (last !== undefined && now - last < REPLY_COOLDOWN_MS) return false;
  replyCooldown.set(chatId, now);
  if (replyCooldown.size > COOLDOWN_MAX) {
    const oldest = replyCooldown.keys().next().value;
    if (oldest !== undefined) replyCooldown.delete(oldest);
  }
  return true;
}

/** Test hook: clear the per-chat cooldown state. */
export function _resetCooldownForTests(): void {
  replyCooldown.clear();
}

let generation = 0;
let activeAbort: AbortController | null = null;
let wakeSleep: (() => void) | null = null;

// Supersede the current loop (if any): bump the generation and unblock whatever
// it is parked on so it re-checks the generation and exits.
function supersede(): void {
  generation++;
  activeAbort?.abort();
  activeAbort = null;
  if (wakeSleep) {
    wakeSleep();
    wakeSleep = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function tgFetch<T>(
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T | null> {
  const controller = new AbortController();
  activeAbort = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 409 = another poller or a webhook owns updates; other codes = transient.
      console.warn(`[TelegramListener] ${method} HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { ok: boolean; result?: T };
    return body.ok ? (body.result ?? null) : null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return null; // stop() or timeout
    // Redact the token: a fetch error can embed the request URL (which contains
    // the bot token) in its message/cause, which would leak it into the logs.
    const detail = redactTelegramToken(token, String(err instanceof Error ? err.message : err));
    console.warn(`[TelegramListener] ${method} failed: ${detail}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (activeAbort === controller) activeAbort = null;
  }
}

async function runLoop(myGen: number): Promise<void> {
  let offset: number | undefined;
  // Tracks which bot token the *previous* iteration polled, so a switch
  // between the saved config token and an in-flight pairing's token (or vice
  // versa) resets the offset: getUpdates offsets are only meaningful within
  // one bot's own update stream, so carrying a stale offset across a token
  // switch could skip or misinterpret updates for the new bot.
  let currentToken: string | null = null;

  while (myGen === generation) {
    let configToken: string | null;
    try {
      configToken = await readTelegramBotToken();
    } catch (err) {
      // A DB blip must not kill the loop; back off and retry.
      console.warn(
        '[TelegramListener] destination read failed:',
        err instanceof Error ? err.message : err
      );
      await sleep(IDLE_MS);
      continue;
    }

    // An active interactive pairing (services/telegramPairing.ts) overrides
    // the config token - see that module's resolvePollingToken() for why.
    const token = resolvePollingToken(configToken);
    if (!token) {
      currentToken = null;
      await sleep(IDLE_MS);
      continue;
    }
    if (token !== currentToken) {
      currentToken = token;
      offset = undefined;
    }

    // On the first poll with a token, skip the backlog so a restart doesn't
    // re-answer stale /start messages: grab only the latest update and advance
    // past it without replying. On failure keep offset undefined (retry the
    // drain) rather than falling to 0, which would replay the whole backlog.
    if (offset === undefined) {
      const latest = await tgFetch<TgUpdate[]>(
        token,
        'getUpdates',
        { offset: -1, timeout: 0 },
        15_000
      );
      if (!latest) {
        await sleep(IDLE_MS);
        continue;
      }
      const last = latest.length ? latest[latest.length - 1] : undefined;
      offset = last ? last.update_id + 1 : 0;
      continue;
    }

    const updates = await tgFetch<TgUpdate[]>(
      token,
      'getUpdates',
      { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message'] },
      (LONG_POLL_SECONDS + 10) * 1000
    );
    if (!updates) {
      await sleep(IDLE_MS);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;

      // Pairing codes take priority and are NOT subject to the per-chat
      // reply cooldown below: the code is single-use (matchPairingCode
      // consumes it on match), so it is already self-limiting, and gating it
      // on allowReply could silently drop the pairing confirmation if the
      // same chat happened to get an unrelated reply (e.g. /chatid) in the
      // last REPLY_COOLDOWN_MS.
      const pairingMatch = matchPairingCode(update);
      if (pairingMatch) {
        await tgFetch(
          token,
          'sendMessage',
          { chat_id: pairingMatch.chatId, text: pairingMatch.text },
          10_000
        );
        continue;
      }

      const reply = chatIdReplyFor(update);
      if (reply && allowReply(reply.chatId)) {
        await tgFetch(token, 'sendMessage', { chat_id: reply.chatId, text: reply.text }, 10_000);
      }
    }
  }
}

export function startTelegramCommandListener(): void {
  supersede(); // cancel any prior loop first
  const myGen = generation;
  void runLoop(myGen).catch((err: unknown) => {
    console.warn('[TelegramListener] loop crashed:', err instanceof Error ? err.message : err);
  });
  console.log('[TelegramListener] started (answers /start and /chatid with the chat ID)');
}

export function stopTelegramCommandListener(): void {
  supersede();
}
