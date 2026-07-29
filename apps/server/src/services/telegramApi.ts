/**
 * Tiny shared helper for the two things that talk to the Telegram Bot API:
 * jobs/telegramCommandListener.ts (long-poll getUpdates/sendMessage) and
 * services/telegramPairing.ts (one-off getMe validation call when starting a
 * pairing). Kept to just the token-redaction concern so both call sites can
 * never independently forget it - see telegramCommandListener.ts's original
 * comment on why: a thrown fetch error can embed the request URL (which
 * contains the bot token) in its message or cause, leaking it into logs.
 */

/** Redact a bot token from a string before it is logged or surfaced. */
export function redactTelegramToken(token: string, text: string): string {
  return text.replaceAll(token, '<token>');
}
