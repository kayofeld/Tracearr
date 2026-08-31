import { describe, expect, it } from 'vitest';
import type { EngineAutomation, TriggerNode } from '@tracearr/shared';
import { CROSSING_PAD_MS, HOLD_OPEN_RECHECK_MS, pauseCrossings } from '../wakes/crossings.js';

const MIN = 60_000;
const t0 = Date.UTC(2026, 7, 16, 12, 0, 0);

interface Cond {
  field: string;
  operator: string;
  value: number;
}

function heldFor(
  minutes: number,
  measure: 'current' | 'total' = 'current',
  enabled = true
): TriggerNode {
  return {
    id: `n-${measure}-${minutes}`,
    type: 'session.held_for',
    enabled,
    params: { minutes, measure },
  };
}

function rule(
  id: string,
  triggers: TriggerNode[],
  groupConds: Cond[][] = [],
  overrides: Partial<EngineAutomation> = {}
): EngineAutomation {
  return {
    id,
    name: id,
    isActive: true,
    severity: 'warning',
    triggers,
    conditions: { groups: groupConds.map((conditions) => ({ conditions })) },
    actions: { actions: [] },
    ...overrides,
  } as unknown as EngineAutomation;
}

describe('pauseCrossings', () => {
  it('a current measure crosses at lastPausedAt plus the node minutes, plus the pad', () => {
    const rules = [rule('a', [heldFor(30)])];
    const r = pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0 + 1000, rules });
    const crossing = { at: t0 + 30 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-30' };
    expect(r.next).toEqual(crossing);
    expect(r.earliest).toEqual(crossing);
    expect(r.holdOpen).toBe(false);
  });

  it('a total measure subtracts the pause time already banked', () => {
    const rules = [rule('a', [heldFor(30, 'total')])];
    const r = pauseCrossings({
      lastPausedAt: t0,
      pausedDurationMs: 20 * MIN,
      now: t0 + 1000,
      rules,
    });
    expect(r.next).toEqual({ at: t0 + 10 * MIN + CROSSING_PAD_MS, nodeId: 'n-total-30' });
  });

  it('a total threshold already exceeded by banked time is a past crossing', () => {
    const rules = [rule('t', [heldFor(30, 'total')])];
    const r = pauseCrossings({
      lastPausedAt: t0,
      pausedDurationMs: 40 * MIN,
      now: t0 + 1000,
      rules,
    });
    expect(r.next).toBeNull();
    expect(r.earliest).toEqual({
      at: t0 + 30 * MIN - 40 * MIN + CROSSING_PAD_MS,
      nodeId: 'n-total-30',
    });
  });

  it('picks the earliest future crossing across rules and across the nodes of one rule', () => {
    const rules = [rule('a', [heldFor(30)]), rule('b', [heldFor(20), heldFor(5)])];
    const r = pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0 + 1000, rules });
    const crossing = { at: t0 + 5 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-5' };
    expect(r.next).toEqual(crossing);
    expect(r.earliest).toEqual(crossing);
  });

  it('drops crossings at or before now from next but keeps them in earliest', () => {
    const rules = [rule('a', [heldFor(5)]), rule('b', [heldFor(60)])];
    const r = pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0 + 20 * MIN, rules });
    expect(r.next).toEqual({ at: t0 + 60 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-60' });
    expect(r.earliest).toEqual({ at: t0 + 5 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-5' });
  });

  it('a pause condition without a held_for node yields no crossing', () => {
    const rules = [
      rule(
        'a',
        [{ id: 'n-p', type: 'session.paused', enabled: true }],
        [[{ field: 'current_pause_minutes', operator: 'gte', value: 5 }]]
      ),
    ];
    expect(pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0, rules })).toEqual({
      next: null,
      earliest: null,
      holdOpen: false,
    });
  });

  it('ignores a disabled node and an inactive rule', () => {
    const rules = [
      rule('a', [heldFor(5, 'current', false)]),
      rule('b', [heldFor(5)], [], { isActive: false }),
    ];
    const r = pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0, rules });
    expect(r.next).toBeNull();
    expect(r.earliest).toBeNull();
  });

  it('holds open once the node is satisfied and the rule still has a non-pause condition', () => {
    const compound = rule(
      'c',
      [heldFor(10)],
      [[{ field: 'concurrent_streams', operator: 'gte', value: 3 }]]
    );

    expect(
      pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0 + MIN, rules: [compound] })
        .holdOpen
    ).toBe(false);

    const after = pauseCrossings({
      lastPausedAt: t0,
      pausedDurationMs: 0,
      now: t0 + 15 * MIN,
      rules: [compound],
    });
    expect(after.holdOpen).toBe(true);
    // The recheck belongs to no node: it waits on a companion condition, not a threshold.
    expect(after.next).toEqual({ at: t0 + 15 * MIN + HOLD_OPEN_RECHECK_MS, nodeId: null });
  });

  it('a switched-off condition cannot flip, so it does not hold the wake open', () => {
    const withDisabled = rule('d', [heldFor(10)], []);
    withDisabled.conditions = {
      groups: [
        {
          conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 3, enabled: false }],
        },
        {
          enabled: false,
          conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }],
        },
      ],
    };

    expect(
      pauseCrossings({
        lastPausedAt: t0,
        pausedDurationMs: 0,
        now: t0 + 15 * MIN,
        rules: [withDisabled],
      }).holdOpen
    ).toBe(false);
  });

  it('a satisfied node whose rule only tests pause time does not hold open', () => {
    const pure = rule(
      'p',
      [heldFor(10)],
      [[{ field: 'total_pause_minutes', operator: 'gte', value: 10 }]]
    );
    expect(
      pauseCrossings({ lastPausedAt: t0, pausedDurationMs: 0, now: t0 + 15 * MIN, rules: [pure] })
    ).toEqual({
      next: null,
      earliest: { at: t0 + 10 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-10' },
      holdOpen: false,
    });
  });

  it('holdOpen recheck does not push out an earlier real crossing', () => {
    const compound = rule(
      'c',
      [heldFor(1)],
      [[{ field: 'concurrent_streams', operator: 'gte', value: 3 }]]
    );
    const later = rule('l', [heldFor(2)]);
    const r = pauseCrossings({
      lastPausedAt: t0,
      pausedDurationMs: 0,
      now: t0 + 100_000,
      rules: [compound, later],
    });
    expect(r.holdOpen).toBe(true);
    expect(r.next).toEqual({ at: t0 + 2 * MIN + CROSSING_PAD_MS, nodeId: 'n-current-2' });
  });

  it('holdOpen recheck comes first when it is nearer', () => {
    const compound = rule(
      'c',
      [heldFor(1)],
      [[{ field: 'concurrent_streams', operator: 'gte', value: 3 }]]
    );
    const later = rule('l', [heldFor(2)]);
    const r = pauseCrossings({
      lastPausedAt: t0,
      pausedDurationMs: 0,
      now: t0 + 90_000,
      rules: [compound, later],
    });
    expect(r.holdOpen).toBe(true);
    expect(r.next).toEqual({ at: t0 + 90_000 + HOLD_OPEN_RECHECK_MS, nodeId: null });
  });
});
