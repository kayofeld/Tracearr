/**
 * Telegram Notification Agent
 *
 * Sends notifications to a Telegram chat via the Bot API. Configured with a bot
 * token (from @BotFather) and a chat ID. Routed through the webhook channel with
 * webhookFormat 'telegram'; unlike the URL-based formats it needs no webhook URL.
 */

import { BaseAgent } from './base.js';
import type {
  NotificationPayload,
  NotificationSettings,
  NotificationEventType,
  SendResult,
  TestResult,
  ViolationContext,
  SessionContext,
  PluginUpdateContext,
  NewDeviceContext,
  TrustScoreChangedContext,
} from '../types.js';
import { formatViolationMessage } from '../formatters/violation.js';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';

interface TelegramMessage {
  title: string;
  body: string;
}

export class TelegramAgent extends BaseAgent {
  readonly name = 'telegram';
  readonly displayName = 'Telegram';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return (
      settings.webhookFormat === 'telegram' &&
      !!settings.telegramBotToken &&
      !!settings.telegramChatId
    );
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      return this.handleError(new Error('Telegram bot token or chat ID not configured'), 'send');
    }
    try {
      const msg = this.buildMessage(payload);
      await this.sendMessage(settings.telegramBotToken, settings.telegramChatId, msg);
      return this.successResult();
    } catch (error) {
      return this.handleError(error, 'send');
    }
  }

  async sendTest(settings: NotificationSettings): Promise<TestResult> {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      return this.failureTestResult('Telegram bot token and chat ID are required');
    }
    try {
      await this.sendMessage(settings.telegramBotToken, settings.telegramChatId, {
        title: 'Test Notification',
        body: 'This is a test notification from Tracearr.',
      });
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildMessage(payload: NotificationPayload): TelegramMessage {
    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolation(payload.context);
      case 'stream_started':
        return this.buildSessionStarted(payload.context);
      case 'stream_stopped':
        return this.buildSessionStopped(payload.context);
      case 'server_down':
        return { title: 'Server Offline', body: `${payload.context.serverName} is not responding` };
      case 'server_up':
        return { title: 'Server Online', body: `${payload.context.serverName} is back online` };
      case 'plugin_update_available':
        return this.buildPluginUpdate(payload.context);
      case 'new_device':
        return this.buildNewDevice(payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChanged(payload.context);
    }
  }

  private buildViolation(ctx: ViolationContext): TelegramMessage {
    return { title: 'Violation Detected', body: formatViolationMessage(ctx.violation) };
  }

  private buildSessionStarted(ctx: SessionContext): TelegramMessage {
    return { title: 'Stream Started', body: this.sessionLine(ctx, 'started watching') };
  }

  private buildSessionStopped(ctx: SessionContext): TelegramMessage {
    const durationStr = ctx.session.durationMs
      ? ` (${this.formatDuration(ctx.session.durationMs)})`
      : '';
    return {
      title: 'Stream Ended',
      body: `${this.sessionLine(ctx, 'finished watching')}${durationStr}`,
    };
  }

  private sessionLine(ctx: SessionContext, verb: string): string {
    const { title, subtitle } = this.getMediaDisplay(ctx.session);
    const media = subtitle ? `${title} - ${subtitle}` : title;
    return `${this.getUserDisplayName(ctx.session)} ${verb} ${media}`;
  }

  private buildPluginUpdate(ctx: PluginUpdateContext): TelegramMessage {
    return {
      title: 'Plugin Update Available',
      body: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
    };
  }

  private buildNewDevice(ctx: NewDeviceContext): TelegramMessage {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      title: 'New Device Detected',
      body: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
    };
  }

  private buildTrustScoreChanged(ctx: TrustScoreChangedContext): TelegramMessage {
    const direction = ctx.newScore < ctx.previousScore ? 'decreased' : 'increased';
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      title: 'Trust Score Changed',
      body: `${ctx.userName}'s trust score ${direction} from ${ctx.previousScore} to ${ctx.newScore}${reasonStr}`,
    };
  }

  /**
   * POST to the Telegram Bot API. Sent as plain text (no parse_mode) so media
   * titles containing < > & are shown literally with no escaping hazard.
   */
  private async sendMessage(botToken: string, chatId: string, msg: TelegramMessage): Promise<void> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${msg.title}\n${msg.body}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Telegram returns a JSON body with a human-readable `description`.
      const detail = (await response.json().catch(() => null)) as { description?: string } | null;
      throw new Error(
        `Telegram sendMessage failed: ${response.status} ${detail?.description ?? ''}`.trim()
      );
    }
  }
}
