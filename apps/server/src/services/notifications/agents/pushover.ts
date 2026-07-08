/**
 * Pushover Notification Agent
 *
 * Sends notifications via Pushover API.
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
  ServerContext,
  PluginUpdateContext,
  NewDeviceContext,
  TrustScoreChangedContext,
} from '../types.js';
import { formatViolationMessage } from '../formatters/violation.js';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';

export class PushoverAgent extends BaseAgent {
  readonly name = 'pushover';
  readonly displayName = 'Pushover';

  private readonly PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return (
      settings.webhookFormat === 'pushover' &&
      !!settings.pushoverUserKey &&
      !!settings.pushoverApiToken
    );
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.pushoverUserKey || !settings.pushoverApiToken) {
      return this.handleError(new Error('Pushover credentials not configured'), 'send');
    }

    try {
      const { title, message, priority } = this.buildPushoverParams(payload);
      await this.sendPushover(
        settings.pushoverUserKey,
        settings.pushoverApiToken,
        title,
        message,
        priority
      );
      return this.successResult();
    } catch (error) {
      return this.handleError(error, 'send');
    }
  }

  async sendTest(settings: NotificationSettings): Promise<TestResult> {
    if (!settings.pushoverUserKey || !settings.pushoverApiToken) {
      return this.failureTestResult('Pushover credentials not configured');
    }

    try {
      await this.sendPushover(
        settings.pushoverUserKey,
        settings.pushoverApiToken,
        'Test Notification',
        'This is a test notification from Tracearr',
        '-1'
      );
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildPushoverParams(payload: NotificationPayload): {
    title: string;
    message: string;
    priority: string;
  } {
    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolationParams(payload.context);
      case 'stream_started':
        return this.buildSessionStartedParams(payload.context);
      case 'stream_stopped':
        return this.buildSessionStoppedParams(payload.context);
      case 'server_down':
        return this.buildServerDownParams(payload.context);
      case 'server_up':
        return this.buildServerUpParams(payload.context);
      case 'plugin_update_available':
        return this.buildPluginUpdateParams(payload.context);
      case 'new_device':
        return this.buildNewDeviceParams(payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChangedParams(payload.context);
    }
  }

  private buildViolationParams(ctx: ViolationContext): {
    title: string;
    message: string;
    priority: string;
  } {
    return {
      title: 'Violation Detected',
      message: formatViolationMessage(ctx.violation),
      priority: this.severityToPushoverPriority(ctx.violation.severity),
    };
  }

  private buildSessionStartedParams(ctx: SessionContext): {
    title: string;
    message: string;
    priority: string;
  } {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

    return {
      title: 'Stream Started',
      message: `${userName} started watching ${mediaDisplay}`,
      priority: '-1',
    };
  }

  private buildSessionStoppedParams(ctx: SessionContext): {
    title: string;
    message: string;
    priority: string;
  } {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
    const durationStr = session.durationMs ? ` (${this.formatDuration(session.durationMs)})` : '';

    return {
      title: 'Stream Ended',
      message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
      priority: '-1',
    };
  }

  private buildServerDownParams(ctx: ServerContext): {
    title: string;
    message: string;
    priority: string;
  } {
    return {
      title: 'Server Offline',
      message: `${ctx.serverName} is not responding`,
      priority: '1',
    };
  }

  private buildServerUpParams(ctx: ServerContext): {
    title: string;
    message: string;
    priority: string;
  } {
    return {
      title: 'Server Online',
      message: `${ctx.serverName} is back online`,
      priority: '1',
    };
  }

  private buildPluginUpdateParams(ctx: PluginUpdateContext): {
    title: string;
    message: string;
    priority: string;
  } {
    return {
      title: 'Plugin Update Available',
      message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
      priority: '-1',
    };
  }

  private buildNewDeviceParams(ctx: NewDeviceContext): {
    title: string;
    message: string;
    priority: string;
  } {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      title: 'New Device Detected',
      message: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
      priority: '0',
    };
  }

  private buildTrustScoreChangedParams(ctx: TrustScoreChangedContext): {
    title: string;
    message: string;
    priority: string;
  } {
    const direction = ctx.newScore < ctx.previousScore ? 'decreased' : 'increased';
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      title: 'Trust Score Changed',
      message: `${ctx.userName}'s trust score ${direction} from ${ctx.previousScore} to ${ctx.newScore}${reasonStr}`,
      priority: ctx.newScore < ctx.previousScore ? '0' : '-1',
    };
  }

  private severityToPushoverPriority(severity: string): string {
    const map: Record<string, string> = { high: '1', warning: '0', low: '-1' };
    return map[severity] ?? '-1';
  }

  private async sendPushover(
    userKey: string,
    apiToken: string,
    title: string,
    message: string,
    priority: string
  ): Promise<void> {
    const body = new URLSearchParams({
      token: apiToken,
      user: userKey,
      title,
      message,
      priority,
    });

    const response = await fetch(this.PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Pushover API failed: ${response.status} ${text}`);
    }
  }
}
