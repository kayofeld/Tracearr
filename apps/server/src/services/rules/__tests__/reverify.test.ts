import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Session } from '@tracearr/shared';
import type * as PollerDatabaseModule from '../../../jobs/poller/database.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    query: {
      sessions: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
  },
}));

vi.mock('../../cache.js', () => ({
  getCacheService: vi.fn(),
}));

vi.mock('../../../jobs/poller/processor.js', () => ({
  gracePeriodSessionIds: vi.fn().mockReturnValue(new Set()),
}));

vi.mock('../../../jobs/poller/database.js', async (importActual) => {
  const actual = await importActual<typeof PollerDatabaseModule>();
  return {
    ...actual,
    batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  };
});

vi.mock('../../termination.js', () => ({
  terminateSession: vi.fn(),
}));

vi.mock('../engine.js', () => ({
  evaluateRulesAsync: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { getCacheService } from '../../cache.js';
import { terminateSession } from '../../termination.js';
import { evaluateRulesAsync } from '../engine.js';
import { reverifyKillCondition } from '../reverify.js';
import {
  batchGetIdentityServerUserIds,
  batchGetRecentUserSessions,
} from '../../../jobs/poller/database.js';

const mockSessionFindFirst = db.query.sessions.findFirst as ReturnType<typeof vi.fn>;
const mockDbSelect = db.select as ReturnType<typeof vi.fn>;
const mockTerminateSession = vi.mocked(terminateSession);
const mockEvaluateRulesAsync = vi.mocked(evaluateRulesAsync);
const mockGetCacheService = vi.mocked(getCacheService);
const mockBatchGetIdentityServerUserIds = vi.mocked(batchGetIdentityServerUserIds);
const mockBatchGetRecentUserSessions = vi.mocked(batchGetRecentUserSessions);

function mockRuleSelect(ruleRow: Record<string, unknown> | undefined) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(ruleRow ? [ruleRow] : []),
      }),
    }),
  });
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  const serverId = randomUUID();
  const serverUserId = randomUUID();
  return {
    id: randomUUID(),
    serverId,
    serverUserId,
    sessionKey: 'session-key-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    ratingKey: '123',
    startedAt: new Date(),
    stoppedAt: null,
    ipAddress: '10.0.0.1',
    deviceId: 'device-1',
    server: {
      id: serverId,
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    serverUser: {
      id: serverUserId,
      userId: randomUUID(),
      serverId,
      externalId: 'ext-1',
      username: 'testuser',
      email: null,
      thumbUrl: null,
      isServerAdmin: false,
      trustScore: 100,
      sessionCount: 1,
      joinedAt: null,
      lastActivityAt: new Date(),
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

function makeRuleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'Test Rule',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('reverifyKillCondition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
    } as never);
  });

  it('returns skipped_already_stopped when the session row is gone', async () => {
    mockSessionFindFirst.mockResolvedValue(undefined);

    const result = await reverifyKillCondition({
      sessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_already_stopped when the session already has stoppedAt set', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow({ stoppedAt: new Date() }));

    const result = await reverifyKillCondition({
      sessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_rule_gone when the rule no longer exists', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    mockRuleSelect(undefined);

    const result = await reverifyKillCondition({
      sessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_rule_gone');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_rule_gone when the rule has been disabled', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    mockRuleSelect(makeRuleRow({ isActive: false }));

    const result = await reverifyKillCondition({
      sessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_rule_gone');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_condition_cleared when the rule no longer matches current state', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: false,
        matchedGroups: [],
        actions: [],
      },
    ]);

    const result = await reverifyKillCondition({
      sessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('skipped_condition_cleared');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('terminates and returns killed when the condition still matches', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
      message: 'Concurrent stream limit exceeded',
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: 'Concurrent stream limit exceeded',
    });
  });

  it('widens recentSessions across the identity for enforceAcrossServers rules', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow({ enforceAcrossServers: true });
    mockRuleSelect(ruleRow);

    const siblingServerUserId = randomUUID();
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId, siblingServerUserId]]])
    );

    const ownSession = { id: 'own-session', serverUserId: sessionRow.serverUserId } as Session;
    const siblingSession = {
      id: 'sibling-session',
      serverUserId: siblingServerUserId,
    } as Session;
    mockBatchGetRecentUserSessions.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, Session[]>();
      for (const id of ids) {
        if (id === sessionRow.serverUserId) map.set(id, [ownSession]);
        else if (id === siblingServerUserId) map.set(id, [siblingSession]);
        else map.set(id, []);
      }
      return map;
    });

    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    // The initial fetch already spans the identity, not just the triggering
    // account, so recentSessions matches what live evaluation matched on.
    expect(mockBatchGetRecentUserSessions).toHaveBeenCalledWith([
      sessionRow.serverUserId,
      siblingServerUserId,
    ]);

    const [context] = mockEvaluateRulesAsync.mock.calls[0]!;
    expect((context.recentSessions as Array<{ id: string }>).map((s) => s.id).sort()).toEqual([
      'own-session',
      'sibling-session',
    ]);
    expect(context.identityServerUserIds).toEqual([sessionRow.serverUserId, siblingServerUserId]);
  });

  it('still derives identity for rules without enforceAcrossServers, but does not widen a single-account identity', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow({ enforceAcrossServers: false });
    mockRuleSelect(ruleRow);
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId]]])
    );
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    // The lookup itself is unconditional - only widening past a single
    // server_user id is skipped, since there's nothing to widen.
    expect(mockBatchGetIdentityServerUserIds).toHaveBeenCalledWith([sessionRow.serverUser.userId]);
    expect(mockBatchGetRecentUserSessions).toHaveBeenCalledWith([sessionRow.serverUserId]);
  });

  it('kills a merged-identity user under a rule without enforceAcrossServers when both accounts together clear the condition', async () => {
    const actualEngine = await vi.importActual<typeof import('../engine.js')>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: false,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'eq', value: 2 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    const siblingServerUserId = randomUUID();
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId, siblingServerUserId]]])
    );
    mockBatchGetRecentUserSessions.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, Session[]>();
      for (const id of ids) map.set(id, []);
      return map;
    });

    const triggeringActiveSession = {
      id: sessionRow.id,
      serverUserId: sessionRow.serverUserId,
      deviceId: 'device-a',
      ipAddress: '10.0.0.1',
    } as Session;
    const siblingActiveSession = {
      id: 'sibling-active-session',
      serverUserId: siblingServerUserId,
      deviceId: 'device-b',
      ipAddress: '10.0.0.2',
    } as Session;
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi
        .fn()
        .mockResolvedValue([triggeringActiveSession, siblingActiveSession]),
    } as never);

    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    // Without unconditional identity aggregation, only the triggering
    // account's session is counted (1), the concurrent_streams == 2
    // condition clears, and this would wrongly abort as
    // skipped_condition_cleared even though live evaluation (which never
    // gates this on enforceAcrossServers) matched both accounts together.
    const result = await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: undefined,
    });
  });

  it('returns failed when termination reports failure', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: false,
      terminationLogId: randomUUID(),
      outcome: 'failed',
      error: 'Session not found (may have already ended)',
    });

    const result = await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('Session not found (may have already ended)');
  });

  it('returns failed when termination throws', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockRejectedValue(new Error('boom'));

    const result = await reverifyKillCondition({
      sessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('boom');
  });
});
