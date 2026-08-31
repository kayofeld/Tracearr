import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AutomationConditions, EngineAutomation } from '@tracearr/shared';

const mockGetActiveAutomations = vi.fn();
const mockBatchIdentity = vi.fn();
vi.mock('../poller/database.js', () => ({
  getActiveAutomations: (...a: unknown[]) => mockGetActiveAutomations(...a),
  batchGetIdentityServerUserIds: (...a: unknown[]) => mockBatchIdentity(...a),
}));
const mockWhere = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (...a: unknown[]) => mockWhere(...a),
      };
      return chain;
    },
  },
}));
vi.mock('../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
const mockDispatch = vi.fn();
vi.mock('../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...a: unknown[]) => mockDispatch(...a),
}));
const mockBroadcast = vi.fn();
vi.mock('../poller/violations.js', () => ({
  broadcastViolations: (...a: unknown[]) => mockBroadcast(...a),
}));
vi.mock('../queueConnection.js', () => ({
  getBullPrefix: () => 'bull',
  queueConnectionOptions: () => ({}),
}));
const { queueRef } = vi.hoisted(() => ({ queueRef: { current: null as any } }));
vi.mock('bullmq', () => {
  class QueueMock {
    getJobSchedulers = vi.fn(async () => [] as { key: string }[]);
    removeJobScheduler = vi.fn(async () => true);
    add = vi.fn(async () => ({}));
    constructor() {
      queueRef.current = this;
    }
    on(): this {
      return this;
    }
  }
  return { Queue: QueueMock, Worker: QueueMock };
});

import { synthesizeTriggers } from '../../services/automations/triggers.js';
import {
  initInactivityCheckQueue,
  processInactivityCheckForTests,
  scheduleInactivityChecks,
} from '../inactivityCheckQueue.js';

function inactivityRule(id: string, scope: Partial<EngineAutomation> = {}): EngineAutomation {
  const conditions: AutomationConditions = {
    groups: [{ conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] }],
  };
  return {
    id,
    name: id,
    isActive: true,
    severity: 'warning',
    conditions,
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    ...scope,
    triggers: scope.triggers !== undefined ? scope.triggers : synthesizeTriggers(conditions),
  } as unknown as EngineAutomation;
}
const candidate = (id: string, userId = 'u1', lastActivityAt: Date | null = null) => ({
  id,
  userId,
  username: id,
  thumbUrl: null,
  identityName: null,
  lastActivityAt,
  trustScore: 100,
  createdAt: new Date(),
  serverId: 'srv1',
  serverName: 'S',
  serverType: 'plex',
});
const job = { id: 'j1', data: { type: 'check' } } as never;
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const dialect = new PgDialect();
/** Scope filters bind ids as strings too, so the cutoff is found by shape, not by position. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
/** The stub applies the query's own cutoff, so the assertion is about the filter and not the mock. */
function rowsMatching(rows: ReturnType<typeof candidate>[]) {
  return (filter: unknown) => {
    const { params } = dialect.sqlToQuery(filter as SQL);
    const bound = params.find((p): p is string => typeof p === 'string' && ISO_TIMESTAMP.test(p));
    const cutoff = bound === undefined ? null : new Date(bound);
    return Promise.resolve(
      rows.filter((r) => cutoff === null || r.lastActivityAt === null || r.lastActivityAt <= cutoff)
    );
  };
}
const dispatchedIds = () =>
  mockDispatch.mock.calls.map((call) => (call[0] as { serverUser: { id: string } }).serverUser.id);

describe('processInactivityCheck', () => {
  const publish = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    initInactivityCheckQueue('redis://x', {} as never, publish);
    mockBatchIdentity.mockResolvedValue(
      new Map([
        ['u1', ['su1']],
        ['u2', ['su2']],
      ])
    );
    mockDispatch.mockResolvedValue({ violations: [], outcomes: [] });
  });

  it('dispatches account.inactive_for once per distinct candidate across rule scopes', async () => {
    mockGetActiveAutomations.mockResolvedValue([
      inactivityRule('a'),
      inactivityRule('b', { serverId: 'srv1' }),
    ]);
    mockWhere
      .mockResolvedValueOnce([candidate('su1'), candidate('su2', 'u2')])
      .mockResolvedValueOnce([candidate('su1')]);
    await processInactivityCheckForTests(job);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    for (const call of mockDispatch.mock.calls) {
      expect(call[0]).toMatchObject({ type: 'account.inactive_for', session: null });
      expect(call[1]).toMatchObject({ activeSessions: [], recentSessions: [] });
      expect(
        (call[1] as { activeAutomations: EngineAutomation[] }).activeAutomations.map((r) => r.id)
      ).toEqual(['a', 'b']);
    }
  });

  it('leaves out accounts the automation days have not reached', async () => {
    mockGetActiveAutomations.mockResolvedValue([inactivityRule('a')]);
    mockWhere.mockImplementation(
      rowsMatching([
        candidate('recent', 'u1', daysAgo(10)),
        candidate('idle', 'u2', daysAgo(40)),
        candidate('never', 'u1', null),
      ])
    );

    await processInactivityCheckForTests(job);

    expect(dispatchedIds()).toEqual(['idle', 'never']);
  });

  it('the cutoff survives a scoped rule, whose ids bind ahead of it', async () => {
    mockGetActiveAutomations.mockResolvedValue([
      inactivityRule('a', { serverId: 'srv1', userId: 'u1' }),
    ]);
    mockWhere.mockImplementation(
      rowsMatching([candidate('recent', 'u1', daysAgo(10)), candidate('idle', 'u2', daysAgo(40))])
    );

    await processInactivityCheckForTests(job);

    expect(dispatchedIds()).toEqual(['idle']);
  });

  it('each automation filters on its own days', async () => {
    const yearly = inactivityRule('y', {
      triggers: [
        {
          id: '0f5b8d4a-9c6e-4a2b-8d1f-3c7e5a9b1d24',
          type: 'account.inactive_for',
          enabled: true,
          params: { days: 365 },
        },
      ],
    });
    mockGetActiveAutomations.mockResolvedValue([yearly]);
    mockWhere.mockImplementation(
      rowsMatching([candidate('idle', 'u2', daysAgo(40)), candidate('ancient', 'u1', daysAgo(400))])
    );

    await processInactivityCheckForTests(job);

    expect(dispatchedIds()).toEqual(['ancient']);
  });

  it('broadcasts returned violations keyed by the server user', async () => {
    mockGetActiveAutomations.mockResolvedValue([inactivityRule('a')]);
    mockWhere.mockResolvedValueOnce([candidate('su1')]);
    mockDispatch.mockResolvedValue({
      violations: [{ violation: { id: 'v1' }, rule: { id: 'a', name: 'a', type: null } }],
      outcomes: [],
    });
    await processInactivityCheckForTests(job);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.any(Array),
      { serverUserId: 'su1' },
      { publish }
    );
  });

  it('does nothing when no active rule carries the account.inactive_for trigger', async () => {
    const conditions: AutomationConditions = {
      groups: [{ conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] }],
    };
    mockGetActiveAutomations.mockResolvedValue([
      { ...inactivityRule('x'), conditions, triggers: synthesizeTriggers(conditions) },
    ]);
    await processInactivityCheckForTests(job);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('skips a rule whose triggers were never stamped', async () => {
    mockGetActiveAutomations.mockResolvedValue([inactivityRule('x', { triggers: [] })]);
    await processInactivityCheckForTests(job);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('skips a rule whose account.inactive_for node is disabled', async () => {
    const disabled = inactivityRule('x');
    mockGetActiveAutomations.mockResolvedValue([
      inactivityRule('x', {
        triggers: (disabled.triggers ?? []).map((node) => ({ ...node, enabled: false })),
      }),
    ]);
    await processInactivityCheckForTests(job);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('honours a job scoped to one rule', async () => {
    mockGetActiveAutomations.mockResolvedValue([inactivityRule('a'), inactivityRule('b')]);
    mockWhere.mockResolvedValueOnce([candidate('su1')]);
    await processInactivityCheckForTests({
      id: 'j2',
      data: { type: 'check', ruleId: 'b' },
    } as never);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(
      (
        mockDispatch.mock.calls[0]?.[1] as { activeAutomations: EngineAutomation[] }
      ).activeAutomations.map((r) => r.id)
    ).toEqual(['b']);
  });

  it('a failing dispatch for one candidate does not stop the others', async () => {
    mockGetActiveAutomations.mockResolvedValue([inactivityRule('a')]);
    mockWhere.mockResolvedValueOnce([candidate('su1'), candidate('su2', 'u2')]);
    mockDispatch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ violations: [], outcomes: [] });
    await processInactivityCheckForTests(job);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleInactivityChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initInactivityCheckQueue('redis://x', {} as never, vi.fn());
  });

  it('clears existing schedulers by their key, which is what BullMQ reports', async () => {
    queueRef.current.getJobSchedulers.mockResolvedValue([
      { key: 'inactivity-check-repeatable', name: 'scheduled-check' },
    ]);
    mockGetActiveAutomations.mockResolvedValue([]);

    await scheduleInactivityChecks();

    expect(queueRef.current.removeJobScheduler).toHaveBeenCalledWith('inactivity-check-repeatable');
  });
});
