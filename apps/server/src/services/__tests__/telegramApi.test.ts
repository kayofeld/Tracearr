import { describe, it, expect } from 'vitest';
import { redactTelegramToken } from '../telegramApi.js';

describe('redactTelegramToken', () => {
  it('replaces every occurrence of the token with a placeholder', () => {
    const token = '123456789:AAExampleTokenValueNotReal';
    const text = `fetch failed: https://api.telegram.org/bot${token}/getMe (cause: bot${token})`;

    const redacted = redactTelegramToken(token, text);

    expect(redacted).not.toContain(token);
    expect(redacted).toBe(
      'fetch failed: https://api.telegram.org/bot<token>/getMe (cause: bot<token>)'
    );
  });

  it('is a no-op when the token is not present', () => {
    expect(redactTelegramToken('some-token', 'unrelated error')).toBe('unrelated error');
  });
});
