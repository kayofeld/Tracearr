/**
 * The per-event push copy an automation's send may replace. Everything below the
 * message builder is stubbed: the point is which title and body reach Expo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';
import type { ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../test/fixtures.js';

const { sent, rows } = vi.hoisted(() => ({
  sent: [] as ExpoPushMessage[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken = () => true;
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    chunkPushNotifications(messages: ExpoPushMessage[]) {
      return [messages];
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    async sendPushNotificationsAsync(messages: ExpoPushMessage[]) {
      sent.push(...messages);
      return messages.map(() => ({ status: 'ok' as const, id: 'receipt-1' }));
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    async getPushNotificationReceiptsAsync() {
      return {};
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    chunkPushNotificationReceiptIds(ids: string[]) {
      return [ids];
    }
  }
  return { Expo };
});

/** Every drizzle step returns the same thenable, so both queries resolve to `rows`. */
vi.mock('../../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  for (const key of ['select', 'from', 'leftJoin', 'where', 'limit', 'update', 'set']) {
    chain[key] = () => chain;
  }
  chain['then'] = (resolve: (value: unknown) => unknown) => resolve(rows);
  return { db: chain };
});

vi.mock('../pushRateLimiter.js', () => ({ getPushRateLimiter: () => null }));
vi.mock('../quietHours.js', () => ({
  quietHoursService: { shouldSend: () => true, shouldSendEvent: () => true },
}));
vi.mock('../pushEncryption.js', () => ({
  pushEncryptionService: { encryptIfEnabled: (data: unknown) => data },
}));
vi.mock('../../routes/settings.js', () => ({
  getNetworkSettings: async () => ({ externalUrl: null }),
}));
vi.mock('../imageProxy.js', () => ({
  buildPushPosterUrl: () => null,
  buildPushAvatarUrl: () => null,
  buildLogoUrl: () => null,
}));

import { pushNotificationService } from '../pushNotification.js';

const session = createMockActiveSession({
  mediaTitle: 'Arrival',
  server: { id: 'srv-1', name: 'Living Room', type: 'plex' },
  user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: 'Alice' },
});

const violation: ViolationWithDetails = {
  id: 'violation-1',
  ruleId: 'rule-1',
  serverUserId: 'su-1',
  sessionId: null,
  severity: 'warning',
  data: {},
  acknowledgedAt: null,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  user: {
    id: 'su-1',
    username: 'alice',
    serverId: 'srv-1',
    thumbUrl: null,
    identityName: 'Alice',
    userId: 'user-1',
  },
  rule: { id: 'rule-1', name: 'Too many streams', type: null },
  server: { id: 'srv-1', name: 'Living Room', type: 'plex' },
};

const override = { title: 'Heads up', body: 'Alice pressed play' };

function only(): ExpoPushMessage {
  expect(sent).toHaveLength(1);
  const message = sent[0];
  if (!message) throw new Error('nothing was sent');
  return message;
}

beforeEach(() => {
  sent.length = 0;
  rows.length = 0;
  rows.push({
    expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    mobileSessionId: 'mob-1',
    deviceSecret: null,
    pushEnabled: true,
    onViolationDetected: true,
    onStreamStarted: true,
    onStreamStopped: true,
    onServerDown: true,
    onServerUp: true,
    violationMinSeverity: 1,
    violationRuleTypes: [],
    maxPerMinute: 10,
    maxPerHour: 60,
    quietHoursEnabled: false,
  });
});

describe('per-event push copy', () => {
  it('sends the builtin stream started copy with no override', async () => {
    await pushNotificationService.notifySessionStarted(session);

    expect(only()).toMatchObject({ title: 'Living Room', body: 'Alice: Arrival' });
  });

  it('sends the automation copy for a stream start', async () => {
    await pushNotificationService.notifySessionStarted(session, override);

    expect(only()).toMatchObject({ title: 'Heads up', body: 'Alice pressed play' });
  });

  it('sends the builtin stream stopped copy with no override', async () => {
    await pushNotificationService.notifySessionStopped(session);

    expect(only()).toMatchObject({ title: 'Living Room', body: 'Alice: Arrival' });
  });

  it('sends the automation copy for a stream stop', async () => {
    await pushNotificationService.notifySessionStopped(session, override);

    expect(only()).toMatchObject({ title: 'Heads up', body: 'Alice pressed play' });
  });

  it('sends the builtin violation copy with no override', async () => {
    await pushNotificationService.notifyViolation(violation);

    expect(only()).toMatchObject({ title: 'Living Room', body: 'Alice: Too many streams' });
  });

  it('sends the automation copy for a violation', async () => {
    await pushNotificationService.notifyViolation(violation, override);

    expect(only()).toMatchObject({ title: 'Heads up', body: 'Alice pressed play' });
  });

  it('sends the builtin server down copy with no override', async () => {
    await pushNotificationService.notifyServerDown('Living Room', 'srv-1');

    expect(only()).toMatchObject({ title: 'Living Room', body: 'Connection lost' });
  });

  it('sends the automation copy for a server down', async () => {
    await pushNotificationService.notifyServerDown('Living Room', 'srv-1', override);

    expect(only()).toMatchObject({ title: 'Heads up', body: 'Alice pressed play' });
  });

  it('sends the builtin server up copy with no override', async () => {
    await pushNotificationService.notifyServerUp('Living Room', 'srv-1');

    expect(only()).toMatchObject({ title: 'Living Room', body: 'Back online' });
  });

  it('sends the automation copy for a server up', async () => {
    await pushNotificationService.notifyServerUp('Living Room', 'srv-1', override);

    expect(only()).toMatchObject({ title: 'Heads up', body: 'Alice pressed play' });
  });

  it('sends an update with the text the render resolved', async () => {
    await pushNotificationService.notifyUpdate('Tracearr 2.1.0', 'time to pull', { type: 'x' });

    expect(only()).toMatchObject({ title: 'Tracearr 2.1.0', body: 'time to pull' });
  });
});
