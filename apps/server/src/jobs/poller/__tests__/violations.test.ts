import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_EVENTS } from '@tracearr/shared';

const mockFrom = vi.fn();
const mockLimit = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        mockFrom(table);
        const chain = { innerJoin: () => chain, where: () => ({ limit: mockLimit }) };
        return chain;
      },
    }),
  },
}));
vi.mock('../../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
const mockEnqueue = vi.fn();
vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: (...args: unknown[]) => mockEnqueue(...args),
}));

import { serverUsers, sessions } from '../../../db/schema.js';
import { broadcastViolations } from '../violations.js';

const details = {
  userId: 'su1',
  identityUserId: 'u1',
  username: 'connor',
  thumbUrl: null,
  identityName: 'Connor',
  serverId: 'srv1',
  serverName: 'Plex',
  serverType: 'plex',
};
const result = {
  violation: {
    id: 'v1',
    automationId: 'r1',
    serverUserId: 'su1',
    sessionId: null,
    kind: 'policy',
    outcome: 'completed',
    humanSummary: null,
    severity: 'warning',
    subjectKey: 'su1',
    data: {},
    acknowledgedAt: null,
    dismissedAt: null,
    startedAt: new Date('2026-08-20T10:00:00Z'),
    finishedAt: new Date('2026-08-20T10:00:01Z'),
    createdAt: new Date('2026-08-20T10:00:01Z'),
  },
  rule: { id: 'r1', name: 'Rule', type: null },
} as never;

describe('broadcastViolations', () => {
  const pubSub = { publish: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([details]);
  });

  it('joins from sessions when given a session id', async () => {
    await broadcastViolations([result], 'sess-1', pubSub);
    expect(mockFrom).toHaveBeenCalledWith(sessions);
    expect(pubSub.publish).toHaveBeenNthCalledWith(
      1,
      WS_EVENTS.VIOLATION_NEW,
      expect.objectContaining({
        id: 'v1',
        user: expect.objectContaining({ id: 'su1', userId: 'u1' }),
      })
    );
    expect(mockEnqueue).toHaveBeenCalledWith({
      type: 'violation',
      payload: expect.objectContaining({ id: 'v1' }),
    });
  });

  it('follows the violations with one run event naming only the stale lists', async () => {
    await broadcastViolations([result], 'sess-1', pubSub);

    expect(pubSub.publish).toHaveBeenCalledTimes(2);
    expect(pubSub.publish).toHaveBeenNthCalledWith(2, WS_EVENTS.RUN_FINISHED, [
      { id: 'v1', automationId: 'r1', kind: 'policy', outcome: 'completed' },
    ]);
  });

  it('joins from serverUsers when given a server user id', async () => {
    await broadcastViolations([result], { serverUserId: 'su1' }, pubSub);
    expect(mockFrom).toHaveBeenCalledWith(serverUsers);
    const payload = pubSub.publish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('session');
    expect(payload).toMatchObject({ server: { id: 'srv1', name: 'Plex', type: 'plex' } });
  });

  it('does nothing without a pubsub service or without violations', async () => {
    await broadcastViolations([result], 'sess-1', null);
    await broadcastViolations([], 'sess-1', pubSub);
    expect(pubSub.publish).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
