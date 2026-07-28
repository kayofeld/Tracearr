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

const appUpdatePayload: NotificationPayload = {
  event: 'app_update_available',
  title: 'Tracearr Update Available',
  message: 'A new Tracearr release is available (current 1.4.0, latest 1.5.0)',
  severity: 'low',
  timestamp: new Date().toISOString(),
  context: {
    type: 'app_update_available',
    currentVersion: '1.4.0',
    latestVersion: '1.5.0',
    releaseUrl: 'https://github.com/kayofeld/Tracearr/releases/tag/v1.5.0',
  },
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

    it('renders an app update message containing both versions and the release link', async () => {
      const result = await agent.send(appUpdatePayload, baseSettings());
      expect(result.success).toBe(true);

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as { body: string }).body) as { text: string };
      expect(body.text).toContain('Tracearr Update Available');
      expect(body.text).toContain('1.4.0');
      expect(body.text).toContain('1.5.0');
      expect(body.text).toContain('https://github.com/kayofeld/Tracearr/releases/tag/v1.5.0');
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
