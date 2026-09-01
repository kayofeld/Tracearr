import { DESTINATION_TYPES } from '@tracearr/shared';
import { toNotificationPayload } from '../types.js';
import { redactTelegramToken } from '../../telegramApi.js';
import { build as buildPlainMessage } from './apprise.js';
import type { DeliverContext, DestinationType } from './types.js';

export interface TelegramConfig {
  botToken: string;
  /** Filled by the pairing flow (services/telegramPairing.ts), not typed in. */
  chatId: string;
}

export interface TelegramMessage {
  text: string;
}

/**
 * POST to the Telegram Bot API. Plain text with no parse_mode, so media titles
 * containing < > & are shown literally instead of being parsed as entities.
 *
 * The bot token sits in the request path, so a thrown fetch error can carry it
 * in the message or cause; every error out of here is redacted first.
 */
async function send(
  config: TelegramConfig,
  message: TelegramMessage,
  ctx: DeliverContext
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message.text,
        disable_web_page_preview: true,
      }),
      signal: ctx.signal,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Telegram sendMessage failed: ${redactTelegramToken(config.botToken, detail)}`,
      { cause: err }
    );
  }

  if (!response.ok) {
    // Telegram returns a JSON body with a human-readable `description`.
    const detail = (await response.json().catch(() => null)) as { description?: string } | null;
    throw new Error(
      `Telegram sendMessage failed: ${response.status} ${detail?.description ?? ''}`.trim()
    );
  }
}

export const telegramType: DestinationType<TelegramConfig, TelegramMessage> = {
  kind: 'telegram',
  events: DESTINATION_TYPES.telegram.events,
  render: (event, _config, ctx) => {
    const { title, body } = buildPlainMessage(toNotificationPayload(event, ctx.source));
    return { text: `${title}\n${body}` };
  },
  deliver: (message, config, ctx) => send(config, message, ctx),
  test: (config, ctx) =>
    send(config, { text: 'Test Notification\nThis is a test notification from Tracearr' }, ctx),
};
