import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, resetDispatcherForTests, subscribe } from '../events/dispatcher.js';
import type { EvaluationInputs, SessionRefEvent } from '../events/types.js';

const { errorLog } = vi.hoisted(() => ({ errorLog: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: errorLog, debug: vi.fn() },
}));

const endedEvent: SessionRefEvent = {
  type: 'session.ended',
  at: new Date(),
  sessionId: 's1',
  serverId: 'srv1',
};

function inputs(): EvaluationInputs {
  return { activeAutomations: [], activeSessions: [], recentSessions: [] };
}

describe('dispatch', () => {
  beforeEach(() => {
    resetDispatcherForTests();
    errorLog.mockClear();
  });

  it('runs subscribers in registration order and concatenates their violations', async () => {
    const order: string[] = [];
    subscribe('session.ended', 'a', async () => {
      order.push('a');
      return {
        violations: [
          { violation: { id: 'v1' } as never, rule: { id: 'r', name: 'r', type: null } },
        ],
      };
    });
    subscribe('session.ended', 'b', async () => {
      order.push('b');
      return {
        violations: [
          { violation: { id: 'v2' } as never, rule: { id: 'r', name: 'r', type: null } },
        ],
      };
    });

    const result = await dispatch(endedEvent, inputs());

    expect(order).toEqual(['a', 'b']);
    expect(result.violations.map((v) => v.violation.id)).toEqual(['v1', 'v2']);
    expect(result.outcomes).toEqual([
      { subscriber: 'a', ok: true },
      { subscriber: 'b', ok: true },
    ]);
  });

  it('isolates a throwing subscriber when there is no tx and keeps going', async () => {
    const boom = new Error('boom');
    subscribe('session.ended', 'a', async () => {
      throw boom;
    });
    const b = vi.fn(async () => undefined);
    subscribe('session.ended', 'b', b);

    const result = await dispatch(endedEvent, inputs());

    expect(b).toHaveBeenCalledTimes(1);
    expect(result.outcomes).toEqual([
      { subscriber: 'a', ok: false, error: boom },
      { subscriber: 'b', ok: true },
    ]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      'Rule subscriber failed',
      expect.objectContaining({
        trigger: 'session.ended',
        subscriber: 'a',
        subject: 's1',
        error: boom,
      })
    );
  });

  it('logs the session id as the subject for session events', async () => {
    subscribe('session.paused', 'a', async () => {
      throw new Error('boom');
    });

    await dispatch(
      {
        type: 'session.paused',
        at: new Date(),
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
        session: { id: 'sess-9' } as never,
        pauseData: { lastPausedAt: null, pausedDurationMs: 0 },
      },
      inputs()
    );

    expect(errorLog).toHaveBeenCalledWith(
      'Rule subscriber failed',
      expect.objectContaining({ subject: 'sess-9' })
    );
  });

  it('logs the server user as the subject for account events', async () => {
    subscribe('account.inactive_for', 'a', async () => {
      throw new Error('boom');
    });

    await dispatch(
      {
        type: 'account.inactive_for',
        at: new Date(),
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
        session: null,
      },
      inputs()
    );

    expect(errorLog).toHaveBeenCalledWith(
      'Rule subscriber failed',
      expect.objectContaining({ subject: 'su1' })
    );
  });

  it('propagates a throwing subscriber when opts.tx is set', async () => {
    subscribe('session.ended', 'a', async () => {
      throw new Error('serialization failure');
    });

    await expect(dispatch(endedEvent, inputs(), { tx: {} as never })).rejects.toThrow(
      'serialization failure'
    );
  });

  it('returns deferred actions as one closure and does not run them', async () => {
    const ranA = vi.fn(async () => [
      { action: { type: 'trust', mode: 'reset' }, success: true } as never,
    ]);
    const ranB = vi.fn(async () => [{ action: { type: 'send' }, success: true } as never]);
    subscribe('session.ended', 'a', async () => ({ violations: [], deferredActions: ranA }));
    subscribe('session.ended', 'b', async () => ({ violations: [], deferredActions: ranB }));

    const result = await dispatch(endedEvent, inputs(), { deferActions: true });

    expect(ranA).not.toHaveBeenCalled();
    expect(ranB).not.toHaveBeenCalled();
    const results = await result.deferredActions!();
    expect(ranA).toHaveBeenCalledTimes(1);
    expect(ranB).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.action.type)).toEqual(['trust', 'send']);
  });

  it('passes inputs by reference', async () => {
    const shared = inputs();
    let seen: EvaluationInputs | undefined;
    subscribe('session.ended', 'a', async (_e, i) => {
      seen = i;
    });

    await dispatch(endedEvent, shared);

    expect(seen).toBe(shared);
  });

  it('returns an empty result when nothing is subscribed', async () => {
    const result = await dispatch(endedEvent, inputs());
    expect(result).toEqual({ violations: [], outcomes: [] });
  });
});
