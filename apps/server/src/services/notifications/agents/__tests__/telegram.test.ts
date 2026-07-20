import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAgent } from '../telegram.js';
import type { NotificationSettings, NotificationPayload } from '../../types.js';

const baseSettings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  discordWebhookUrl: null,
  customWebhookUrl: null,
  webhookFormat: 'telegram',
  ntfyTopic: null,
  ntfyAuthToken: null,
  pushoverUserKey: null,
  pushoverApiToken: null,
  telegramBotToken: 'BOT:TOKEN',
  telegramChatId: '12345',
  ...over,
});

const serverDownPayload: NotificationPayload = {
  event: 'server_down',
  title: 'Server Offline',
  message: 'My Emby is not responding',
  severity: 'high',
  timestamp: new Date().toISOString(),
  context: { type: 'server_down', serverName: 'My Emby' },
};

describe('TelegramAgent', () => {
  const agent = new TelegramAgent();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('shouldSend', () => {
    it('true only when format=telegram and both token + chat id are set', () => {
      expect(agent.shouldSend('server_down', baseSettings())).toBe(true);
      expect(agent.shouldSend('server_down', baseSettings({ telegramBotToken: null }))).toBe(false);
      expect(agent.shouldSend('server_down', baseSettings({ telegramChatId: null }))).toBe(false);
      expect(agent.shouldSend('server_down', baseSettings({ webhookFormat: 'ntfy' }))).toBe(false);
    });
  });

  describe('send', () => {
    it('POSTs to the bot sendMessage URL with chat_id and the message text', async () => {
      const result = await agent.send(serverDownPayload, baseSettings());
      expect(result.success).toBe(true);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.telegram.org/botBOT:TOKEN/sendMessage');
      const body = JSON.parse((init as { body: string }).body) as {
        chat_id: string;
        text: string;
      };
      expect(body.chat_id).toBe('12345');
      expect(body.text).toContain('Server Offline');
      expect(body.text).toContain('My Emby');
    });

    it('fails (without throwing) when token/chat id missing', async () => {
      const result = await agent.send(serverDownPayload, baseSettings({ telegramChatId: null }));
      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("surfaces Telegram's error description on a non-ok response", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: 'chat not found' }),
      });
      const result = await agent.send(serverDownPayload, baseSettings());
      expect(result.success).toBe(false);
      expect(result.error).toContain('chat not found');
    });
  });

  describe('sendTest', () => {
    it('sends a test message and reports success', async () => {
      const result = await agent.sendTest(baseSettings());
      expect(result.success).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as { text: string };
      expect(body.text).toContain('Test Notification');
    });

    it('fails validation when not configured', async () => {
      const result = await agent.sendTest(baseSettings({ telegramBotToken: null }));
      expect(result.success).toBe(false);
    });
  });
});
