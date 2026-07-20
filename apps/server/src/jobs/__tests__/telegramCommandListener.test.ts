import { describe, it, expect, beforeEach } from 'vitest';
import { chatIdReplyFor, allowReply, _resetCooldownForTests } from '../telegramCommandListener.js';

describe('chatIdReplyFor', () => {
  const upd = (text: string | undefined, chatId: unknown = 4242) => ({
    update_id: 1,
    message:
      text === undefined ? {} : { text, chat: chatId === undefined ? undefined : { id: chatId } },
  });

  it('answers /start with the chat ID', () => {
    const r = chatIdReplyFor(upd('/start') as never);
    expect(r?.chatId).toBe(4242);
    expect(r?.text).toContain('4242');
  });

  it('answers /chatid', () => {
    expect(chatIdReplyFor(upd('/chatid') as never)?.chatId).toBe(4242);
  });

  it('strips the @BotName suffix used in groups', () => {
    expect(chatIdReplyFor(upd('/start@MyTracearrBot') as never)?.chatId).toBe(4242);
  });

  it('is case-insensitive on the command', () => {
    expect(chatIdReplyFor(upd('/START') as never)?.chatId).toBe(4242);
  });

  it('ignores non-command text', () => {
    expect(chatIdReplyFor(upd('hello there') as never)).toBeNull();
  });

  it('ignores a message with no text', () => {
    expect(chatIdReplyFor(upd(undefined) as never)).toBeNull();
  });

  it('ignores a command with no chat id', () => {
    expect(chatIdReplyFor({ update_id: 1, message: { text: '/start' } })).toBeNull();
  });
});

describe('allowReply (per-chat cooldown)', () => {
  beforeEach(() => _resetCooldownForTests());

  it('allows the first reply and blocks a repeat within the cooldown', () => {
    expect(allowReply(1, 1_000)).toBe(true);
    expect(allowReply(1, 5_000)).toBe(false); // 4s later, still within 60s
  });

  it('allows again once the cooldown has elapsed', () => {
    expect(allowReply(1, 1_000)).toBe(true);
    expect(allowReply(1, 1_000 + 60_000)).toBe(true);
  });

  it('tracks chats independently', () => {
    expect(allowReply(1, 1_000)).toBe(true);
    expect(allowReply(2, 1_000)).toBe(true);
  });
});
