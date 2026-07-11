/**
 * Push payload identity field integration tests.
 *
 * The push payload's `data.userId` field has historically carried a
 * serverUserId (the account on one server), not the person's real identity
 * id. Confirms notifications now also carry `serverUserId` (explicit alias)
 * and `identityUserId` (users.id) alongside the untouched legacy `userId`.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- pushPayloadIdentityFields
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';
import type { ViolationWithDetails } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { mobileSessions, notificationPreferences } from '../../src/db/schema.js';
import { createMockActiveSession } from '../../src/test/fixtures.js';

const sentMessages = vi.hoisted(() => [] as ExpoPushMessage[]);

vi.mock('expo-server-sdk', () => {
  class MockExpo {
    static isExpoPushToken(token: unknown) {
      return typeof token === 'string' && token.startsWith('ExponentPushToken[');
    }
    chunkPushNotifications(messages: ExpoPushMessage[]) {
      return [messages];
    }
    async sendPushNotificationsAsync(messages: ExpoPushMessage[]) {
      sentMessages.push(...messages);
      return messages.map(() => ({ status: 'ok', id: `receipt-${Math.random()}` }));
    }
    async getPushNotificationReceiptsAsync() {
      return {};
    }
  }
  return { Expo: MockExpo };
});

const { pushNotificationService } = await import('../../src/services/pushNotification.js');

async function createPushableDevice(overrides: {
  onStreamStarted?: boolean;
  onStreamStopped?: boolean;
}) {
  const owner = await createTestUser({ role: 'owner' });
  const [session] = await db
    .insert(mobileSessions)
    .values({
      userId: owner.id,
      refreshTokenHash: `hash-${crypto.randomUUID()}`,
      deviceName: 'Test Device',
      deviceId: crypto.randomUUID(),
      platform: 'ios',
      expoPushToken: `ExponentPushToken[${crypto.randomUUID()}]`,
    })
    .returning();
  if (!session) throw new Error('failed to create mobile session');

  await db.insert(notificationPreferences).values({
    mobileSessionId: session.id,
    onStreamStarted: overrides.onStreamStarted ?? false,
    onStreamStopped: overrides.onStreamStopped ?? false,
  });

  return session;
}

function getData(message: ExpoPushMessage): Record<string, unknown> {
  return message.data as Record<string, unknown>;
}

describe('push payload identity fields', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('violation push carries userId (legacy), serverUserId, and identityUserId', async () => {
    await createPushableDevice({});

    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    const violation: ViolationWithDetails = {
      id: crypto.randomUUID(),
      ruleId: crypto.randomUUID(),
      serverUserId: serverUser.id,
      sessionId: null,
      severity: 'high',
      data: {},
      acknowledgedAt: null,
      createdAt: new Date(),
      user: {
        id: serverUser.id,
        username: serverUser.username,
        thumbUrl: null,
        serverId: server.id,
        identityName: null,
        // Deliberately omitted, matching the poller's payload shape - the
        // service must look this up itself rather than assume it's present.
      },
      rule: { id: crypto.randomUUID(), name: 'Test Rule', type: 'concurrent_streams' },
      server: { id: server.id, name: server.name, type: 'plex' },
    };

    await pushNotificationService.notifyViolation(violation);

    expect(sentMessages).toHaveLength(1);
    const data = getData(sentMessages[0]!);
    expect(data.userId).toBe(serverUser.id);
    expect(data.serverUserId).toBe(serverUser.id);
    expect(data.identityUserId).toBe(user.id);
  });

  it('session started push carries userId (legacy), serverUserId, and identityUserId', async () => {
    await createPushableDevice({ onStreamStarted: true });

    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    const session = createMockActiveSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      server: { id: server.id, name: server.name, type: 'plex' },
    });

    await pushNotificationService.notifySessionStarted(session);

    expect(sentMessages).toHaveLength(1);
    const data = getData(sentMessages[0]!);
    expect(data.userId).toBe(serverUser.id);
    expect(data.serverUserId).toBe(serverUser.id);
    expect(data.identityUserId).toBe(user.id);
  });

  it('session stopped push carries userId (legacy), serverUserId, and identityUserId', async () => {
    await createPushableDevice({ onStreamStopped: true });

    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    const session = createMockActiveSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      server: { id: server.id, name: server.name, type: 'plex' },
    });

    await pushNotificationService.notifySessionStopped(session);

    expect(sentMessages).toHaveLength(1);
    const data = getData(sentMessages[0]!);
    expect(data.userId).toBe(serverUser.id);
    expect(data.serverUserId).toBe(serverUser.id);
    expect(data.identityUserId).toBe(user.id);
  });
});
