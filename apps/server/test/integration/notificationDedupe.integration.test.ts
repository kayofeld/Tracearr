/**
 * Dispatcher dedupe against real Redis.
 *
 * The queue leans on BullMQ collapsing a jobId it has already seen instead of
 * throwing, which is the whole reason a repeated event inside one 5-minute
 * bucket doesn't notify twice. A mocked queue can't settle that, so this pins
 * it against the real thing.
 *
 * Run with: pnpm --filter @tracearr/server test:integration notificationDedupe
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { Queue } from 'bullmq';
import {
  enqueueNotification,
  getQueueStats,
  initNotificationQueue,
  shutdownNotificationQueue,
} from '../../src/jobs/notificationQueue.js';
import { getBullPrefix, queueConnectionOptions } from '../../src/jobs/queueConnection.js';
import type { DestinationRow } from '../../src/services/notifications/destinationStore.js';
import type { NotificationEvent } from '../../src/services/notifications/events.js';

vi.mock('../../src/services/notifications/destinationStore.js', () => {
  const row = (id: string): DestinationRow => ({
    id,
    name: `Destination ${id}`,
    type: 'discord',
    config: 'v1:blob',
    events: ['violation_detected'],
    enabled: true,
    builtin: false,
    configStatus: 'ok',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    findDestinationsForEvent: vi.fn(() => Promise.resolve([row('d1'), row('d2')])),
    getDestination: vi.fn(() => Promise.resolve(null)),
    listDestinations: vi.fn(() => Promise.resolve([])),
    readConfig: vi.fn(),
    markReencrypt: vi.fn(),
    rewrapConfig: vi.fn(),
  };
});

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';

const event: NotificationEvent = {
  type: 'violation',
  payload: {
    id: 'v-1',
    ruleId: 'rule-1',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    severity: 'warning',
    data: {},
    acknowledgedAt: null,
    createdAt: new Date(),
    user: { id: 'su-1', username: 'alice', serverId: 'srv-1', thumbUrl: null, identityName: null },
    rule: { id: 'rule-1', name: 'Sharing', type: null },
  },
};

let scratch: Queue;

beforeAll(async () => {
  scratch = new Queue('notifications-v2', {
    connection: queueConnectionOptions(redisUrl),
    prefix: getBullPrefix(),
  });
  await scratch.obliterate({ force: true });
  initNotificationQueue(redisUrl);
});

afterAll(async () => {
  await scratch.obliterate({ force: true });
  await scratch.close();
  await shutdownNotificationQueue();
});

describe('notification dedupe against real Redis', () => {
  it('collapses a repeated event inside one bucket to one waiting job per destination', async () => {
    expect(await enqueueNotification(event)).toBe(2);
    expect(await enqueueNotification(event)).toBe(2);

    const stats = await getQueueStats();
    expect(stats?.waiting).toBe(2);

    const waiting = await scratch.getJobs(['waiting']);
    expect(waiting).toHaveLength(2);
    for (const job of waiting) expect(job.id).not.toMatch(/:/);
  });
});
