import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAutomation } from '@tracearr/shared';

const MIN = 60_000;
const t0 = Date.UTC(2026, 7, 16, 12, 0, 0);

const mockSelectLimit = vi.fn();
const mockSelectWhere = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        // where() awaited directly is the rehydrate scan; where().limit() is the fire-time re-read.
        where: (...a: unknown[]) => ({
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (mockSelectWhere(...a) as Promise<unknown>).then(res, rej),
          limit: (...l: unknown[]) => mockSelectLimit(...l),
        }),
      }),
    }),
  },
}));
vi.mock('../../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
const mockGetActiveAutomations = vi.fn();
const mockOnActiveAutomationsRefill = vi.fn();
vi.mock('../../../jobs/poller/database.js', () => ({
  getActiveAutomations: (...args: unknown[]) => mockGetActiveAutomations(...args),
  onActiveAutomationsRefill: (...args: unknown[]) => mockOnActiveAutomationsRefill(...args),
}));
const mockLoadContext = vi.fn();
vi.mock('../events/contextAssembly.js', () => ({
  loadEvaluationContext: (...args: unknown[]) => mockLoadContext(...args),
  toRuleSession: (row: unknown) => row,
}));
const mockDispatch = vi.fn();
const mockSubscribe = vi.fn();
vi.mock('../events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
}));
const mockBroadcast = vi.fn();
vi.mock('../../../jobs/poller/violations.js', () => ({
  broadcastViolations: (...args: unknown[]) => mockBroadcast(...args),
}));
const mockIsLeader = vi.fn(() => true);
vi.mock('../../leaderLease.js', () => ({ isLeader: () => mockIsLeader() }));
vi.mock('../../../utils/logger.js', () => ({
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  cancelPauseWake,
  pendingWakeCount,
  registerPauseWakeSubscriptions,
  rehydratePauseWakes,
  resetPauseWakesForTests,
  schedulePauseWake,
  setPauseWakeDeps,
  stopPauseWakes,
} from '../wakes/pauseWakes.js';

function pauseRule(minutes: number, id = 'p', enabled = true): EngineAutomation {
  return {
    id,
    name: id,
    isActive: true,
    severity: 'warning',
    triggers: [
      {
        id: `${id}-held`,
        type: 'session.held_for',
        enabled,
        params: { minutes, measure: 'current' },
      },
    ],
    conditions: { groups: [] },
    actions: { actions: [] },
  } as unknown as EngineAutomation;
}
function pausedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    serverId: 'srv1',
    serverUserId: 'su1',
    state: 'paused',
    lastPausedAt: new Date(t0),
    pausedDurationMs: 0,
    stoppedAt: null,
    ...overrides,
  };
}
const refs = {
  server: { id: 'srv1', name: 'S', type: 'plex' },
  serverUser: {
    id: 'su1',
    userId: 'u1',
    username: 'x',
    thumbUrl: null,
    identityName: null,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    identityServerUserIds: [],
  },
};

type Handler = (event: unknown, inputs?: unknown) => Promise<void>;
function handlerFor(trigger: string): Handler {
  const calls = mockSubscribe.mock.calls as unknown as [string, string, Handler][];
  const call = calls.find((c) => c[0] === trigger);
  if (!call) throw new Error(`no subscriber registered for ${trigger}`);
  return call[2];
}

describe('pauseWakes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    vi.clearAllMocks();
    resetPauseWakesForTests();
    setPauseWakeDeps({ pubSubService: null });
    mockIsLeader.mockReturnValue(true);
    mockGetActiveAutomations.mockResolvedValue([pauseRule(10)]);
    mockSelectLimit.mockResolvedValue([pausedRow()]);
    mockSelectWhere.mockImplementation(async () => [pausedRow()]);
    mockLoadContext.mockResolvedValue({
      ...refs,
      inputs: {
        activeAutomations: [pauseRule(10)],
        activeSessions: [],
        recentSessions: [],
        identityServerUserIds: [],
      },
    });
    mockDispatch.mockResolvedValue({ violations: [], outcomes: [] });
  });
  afterEach(() => {
    stopPauseWakes();
    vi.useRealTimers();
  });

  it('schedules one timer per session and fires held_for at the crossing', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    expect(pendingWakeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * MIN + 999);
    expect(mockDispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'session.held_for',
      session: expect.objectContaining({ id: 's1' }),
      triggerNodeId: 'p-held',
    });
  });

  it('names the node whose crossing it fired for', async () => {
    const rules = [pauseRule(5, 'a'), pauseRule(10, 'b')];
    mockGetActiveAutomations.mockResolvedValue(rules);
    schedulePauseWake(pausedRow(), rules);

    await vi.advanceTimersByTimeAsync(5 * MIN + 1001);
    await vi.advanceTimersByTimeAsync(5 * MIN + 5);

    expect(
      mockDispatch.mock.calls.map((call) => (call[0] as { triggerNodeId?: string }).triggerNodeId)
    ).toEqual(['a-held', 'b-held']);
  });

  it('replaces an existing timer for the same session', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    schedulePauseWake(pausedRow(), [pauseRule(5)]);
    expect(pendingWakeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * MIN + 1001);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a null crossing cancels an existing timer', () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    schedulePauseWake(pausedRow(), []);
    expect(pendingWakeCount()).toBe(0);
  });

  it('cancel removes the timer', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    cancelPauseWake('s1');
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('drops the fire when the row is no longer paused', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    mockSelectLimit.mockResolvedValue([pausedRow({ state: 'playing' })]);
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(pendingWakeCount()).toBe(0);
  });

  it('drops the fire when the row is stopped', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    mockSelectLimit.mockResolvedValue([pausedRow({ stoppedAt: new Date() })]);
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(pendingWakeCount()).toBe(0);
  });

  it('reschedules from the row when lastPausedAt moved instead of dropping', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    const newAnchor = new Date(t0 + 4 * MIN);
    mockSelectLimit.mockResolvedValue([pausedRow({ lastPausedAt: newAnchor })]);
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(pendingWakeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * MIN + 5);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('chains to the next threshold after a fire', async () => {
    mockGetActiveAutomations.mockResolvedValue([pauseRule(5, 'a'), pauseRule(10, 'b')]);
    schedulePauseWake(pausedRow(), [pauseRule(5, 'a'), pauseRule(10, 'b')]);
    await vi.advanceTimersByTimeAsync(5 * MIN + 1001);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(pendingWakeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * MIN + 5);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(pendingWakeCount()).toBe(0);
  });

  it('a failing fire logs and retries on the fixed cadence', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    mockDispatch.mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);
    expect(pendingWakeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000 + 1);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('a newer schedule during an in-flight fire supersedes it', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    let resolveRead: ((rows: unknown) => void) | undefined;
    mockSelectLimit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);

    schedulePauseWake(pausedRow({ lastPausedAt: new Date(t0 + 4 * MIN) }), [pauseRule(10)]);
    mockSelectLimit.mockResolvedValue([pausedRow({ lastPausedAt: new Date(t0 + 4 * MIN) })]);
    resolveRead?.([pausedRow()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(pendingWakeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(4 * MIN + 5);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a cancel during an in-flight fire stops the dispatch', async () => {
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    let resolveRead: ((rows: unknown) => void) | undefined;
    mockSelectLimit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);

    cancelPauseWake('s1');
    resolveRead?.([pausedRow()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(pendingWakeCount()).toBe(0);
  });

  it('rehydrate schedules every paused row and evaluates crossings already past immediately', async () => {
    mockSelectWhere.mockImplementationOnce(async () => [
      pausedRow({ id: 'old', lastPausedAt: new Date(t0 - 45 * MIN) }),
      pausedRow({ id: 'fresh', lastPausedAt: new Date(t0 - MIN) }),
    ]);
    mockSelectLimit.mockImplementation(async () => [
      pausedRow({ id: 'old', lastPausedAt: new Date(t0 - 45 * MIN) }),
    ]);
    await rehydratePauseWakes();
    expect(pendingWakeCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'session.held_for',
      session: expect.objectContaining({ id: 'old' }),
    });
  });

  it('broadcasts returned violations with the session id', async () => {
    const pubSubService = { publish: vi.fn() };
    setPauseWakeDeps({ pubSubService });
    mockDispatch.mockResolvedValue({
      violations: [{ violation: { id: 'v1' }, rule: { id: 'p', name: 'p', type: null } }],
      outcomes: [],
    });
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    await vi.advanceTimersByTimeAsync(10 * MIN + 1001);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.any(Array), 's1', pubSubService);
  });

  it('never arms a timer on a follower', () => {
    mockIsLeader.mockReturnValue(false);
    schedulePauseWake(pausedRow(), [pauseRule(10)]);
    expect(pendingWakeCount()).toBe(0);
  });

  it('clamps very long delays instead of overflowing setTimeout', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    schedulePauseWake(pausedRow(), [pauseRule(60 * 24 * 40)]);
    expect(pendingWakeCount()).toBe(1);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(2 ** 31 - 1);
    await vi.advanceTimersByTimeAsync(5);
    expect(mockDispatch).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('registerPauseWakeSubscriptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    vi.clearAllMocks();
    resetPauseWakesForTests();
    setPauseWakeDeps({ pubSubService: null });
    mockIsLeader.mockReturnValue(true);
    mockGetActiveAutomations.mockResolvedValue([pauseRule(10)]);
    mockSelectLimit.mockResolvedValue([pausedRow()]);
    mockSelectWhere.mockImplementation(async () => [pausedRow()]);
    mockDispatch.mockResolvedValue({ violations: [], outcomes: [] });
    registerPauseWakeSubscriptions();
  });
  afterEach(() => {
    stopPauseWakes();
    vi.useRealTimers();
  });

  const inputs = {
    activeAutomations: [pauseRule(10)],
    activeSessions: [],
    recentSessions: [],
  };

  it('session.started schedules only for a row that is already paused', async () => {
    const started = handlerFor('session.started');
    await started({ session: { ...pausedRow(), state: 'playing' } }, inputs);
    expect(pendingWakeCount()).toBe(0);
    await started({ session: { ...pausedRow(), state: 'paused' } }, inputs);
    expect(pendingWakeCount()).toBe(1);
  });

  it('session.paused schedules only when the dispatch carried inputs', async () => {
    const paused = handlerFor('session.paused');
    await paused({ session: pausedRow() }, undefined);
    expect(pendingWakeCount()).toBe(0);
    await paused({ session: pausedRow() }, inputs);
    expect(pendingWakeCount()).toBe(1);
  });

  it.each(['session.resumed', 'session.ended', 'session.media_changed'])(
    '%s cancels the wake',
    async (trigger) => {
      schedulePauseWake(pausedRow(), [pauseRule(10)]);
      expect(pendingWakeCount()).toBe(1);
      await handlerFor(trigger)({ sessionId: 's1', serverId: 'srv1' });
      expect(pendingWakeCount()).toBe(0);
    }
  );

  it('rehydrates only when a pause-rule change follows the baseline fill, on the leader', async () => {
    const refill = mockOnActiveAutomationsRefill.mock.calls[0]?.[0] as (
      rules: EngineAutomation[]
    ) => void;

    refill([pauseRule(10)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).not.toHaveBeenCalled();

    refill([pauseRule(20)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).toHaveBeenCalledTimes(1);
    expect(pendingWakeCount()).toBe(1);

    refill([pauseRule(20)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).toHaveBeenCalledTimes(1);

    mockIsLeader.mockReturnValue(false);
    refill([pauseRule(30)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).toHaveBeenCalledTimes(1);
  });

  it('a disabled held_for node is a fingerprint change and rehydrates', async () => {
    const refill = mockOnActiveAutomationsRefill.mock.calls[0]?.[0] as (
      rules: EngineAutomation[]
    ) => void;

    refill([pauseRule(10)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).not.toHaveBeenCalled();

    refill([pauseRule(10, 'p', false)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).toHaveBeenCalledTimes(1);
  });

  it('a rule with no held_for node leaves the fingerprint alone', async () => {
    const refill = mockOnActiveAutomationsRefill.mock.calls[0]?.[0] as (
      rules: EngineAutomation[]
    ) => void;
    const started = {
      ...pauseRule(10, 'other'),
      triggers: [{ id: 'other-started', type: 'session.started', enabled: true }],
    } as EngineAutomation;

    refill([pauseRule(10)]);
    await vi.advanceTimersByTimeAsync(0);
    refill([pauseRule(10), started]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSelectWhere).not.toHaveBeenCalled();
  });
});
