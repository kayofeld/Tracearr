/**
 * Telegram command listener.
 *
 * Long-polls the Bot API (getUpdates) and answers /start and /chatid with the
 * sender's chat ID, so a user can obtain the ID to paste into the Telegram
 * notification settings without hunting for it. Runs only when a bot token is
 * configured; the token is read fresh each cycle, so adding/changing it later
 * takes effect without a restart. Single instance per server (module guard).
 */

import { getSettings } from '../services/settings.js';

const API = 'https://api.telegram.org';
const LONG_POLL_SECONDS = 30;
const IDLE_MS = 30_000; // no token / error backoff

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

let running = false;
let offset: number | undefined;
let abort: AbortController | null = null;

async function tgFetch<T>(
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T | null> {
  abort = new AbortController();
  const timer = setTimeout(() => abort?.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: abort.signal,
    });
    if (!res.ok) {
      // 409 = another poller or a webhook owns updates; other codes = transient.
      console.warn(`[TelegramListener] ${method} HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { ok: boolean; result?: T };
    return body.ok ? (body.result ?? null) : null;
  } catch (err) {
    if (!running) return null; // aborted by stop()
    // Redact the token: a fetch error can embed the request URL (which contains
    // the bot token) in its message/cause, which would leak it into the logs.
    const detail = String(err instanceof Error ? err.message : err).replaceAll(token, '<token>');
    console.warn(`[TelegramListener] ${method} failed: ${detail}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loop(): Promise<void> {
  while (running) {
    const { telegramBotToken: token } = await getSettings(['telegramBotToken']);
    if (!token) {
      await sleep(IDLE_MS);
      continue;
    }
    // On the first poll with a token, skip the backlog so a restart doesn't
    // re-answer stale /start messages: grab only the latest update and advance
    // past it without replying.
    if (offset === undefined) {
      const latest = await tgFetch<TgUpdate[]>(
        token,
        'getUpdates',
        { offset: -1, timeout: 0 },
        15_000
      );
      const last = latest?.length ? latest[latest.length - 1] : undefined;
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
      const reply = chatIdReplyFor(update);
      if (reply) {
        await tgFetch(token, 'sendMessage', { chat_id: reply.chatId, text: reply.text }, 10_000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startTelegramCommandListener(): void {
  if (running) return;
  running = true;
  offset = undefined;
  void loop();
  console.log('[TelegramListener] started (answers /start and /chatid with the chat ID)');
}

export function stopTelegramCommandListener(): void {
  running = false;
  abort?.abort();
  abort = null;
}
