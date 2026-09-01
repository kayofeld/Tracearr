import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIGGERS } from '@tracearr/shared';
import type { AutomationConditions, TriggerNode } from '@tracearr/shared';

const mockWarn = vi.fn();
vi.mock('../../../utils/logger.js', () => ({
  automationsLogger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { carryTriggerIds, synthesizeTriggers } from '../triggers.js';
import { MEDIA_QUALITY_FIELDS } from '../types.js';

beforeEach(() => {
  mockWarn.mockClear();
});

type Cond = AutomationConditions['groups'][number]['conditions'][number];

const conditions = (...groups: Cond[][]): AutomationConditions => ({
  groups: groups.map((conds) => ({ conditions: conds })),
});
const one = (...conds: Cond[]): AutomationConditions => conditions(conds);

const nodesOf = (triggers: TriggerNode[], type: TriggerNode['type']) =>
  triggers.filter((node) => node.type === type);
const heldFor = (triggers: TriggerNode[]) =>
  triggers.filter((node) => node.type === 'session.held_for');
const inactiveFor = (triggers: TriggerNode[]) =>
  triggers.filter((node) => node.type === 'account.inactive_for');

describe('synthesizeTriggers held_for params', () => {
  it('takes the threshold and measure from a rising pause condition', () => {
    const triggers = synthesizeTriggers(
      one({ field: 'current_pause_minutes', operator: 'gte', value: 15 })
    );
    expect(triggers.map((n) => n.type)).toEqual([
      'session.started',
      'session.paused',
      'session.held_for',
    ]);
    expect(heldFor(triggers)).toEqual([
      {
        id: expect.any(String),
        type: 'session.held_for',
        enabled: true,
        params: { minutes: 15, measure: 'current' },
      },
    ]);
  });

  it('reads total_pause_minutes as the total measure', () => {
    const triggers = synthesizeTriggers(
      one({ field: 'total_pause_minutes', operator: 'gt', value: 30 })
    );
    expect(heldFor(triggers)[0]?.params).toEqual({ minutes: 30, measure: 'total' });
  });

  it('two distinct thresholds become two nodes, in condition order', () => {
    const triggers = synthesizeTriggers(
      conditions(
        [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }],
        [{ field: 'total_pause_minutes', operator: 'gte', value: 45 }]
      )
    );
    expect(heldFor(triggers).map((n) => n.params)).toEqual([
      { minutes: 15, measure: 'current' },
      { minutes: 45, measure: 'total' },
    ]);
  });

  it('the same measure and threshold twice is one node', () => {
    const triggers = synthesizeTriggers(
      conditions(
        [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }],
        [{ field: 'current_pause_minutes', operator: 'gt', value: 15 }]
      )
    );
    expect(heldFor(triggers)).toHaveLength(1);
  });

  it('a disabled condition supplies no threshold', () => {
    const triggers = synthesizeTriggers(
      conditions(
        [{ field: 'current_pause_minutes', operator: 'gte', value: 15, enabled: false }],
        [{ field: 'total_pause_minutes', operator: 'gte', value: 45 }]
      )
    );
    expect(heldFor(triggers).map((n) => n.params)).toEqual([{ minutes: 45, measure: 'total' }]);
  });

  it('a pause rule with nothing rising gets a disabled default node', () => {
    const triggers = synthesizeTriggers(
      one({ field: 'current_pause_minutes', operator: 'lt', value: 5 })
    );
    expect(heldFor(triggers)).toEqual([
      {
        id: expect.any(String),
        type: 'session.held_for',
        enabled: false,
        params: { minutes: 30, measure: 'current' },
      },
    ]);
    expect(nodesOf(triggers, 'session.paused')[0]?.enabled).toBe(true);
  });

  it('a threshold the schema would reject falls back to the disabled default', () => {
    for (const value of [0, 2000, 12.5, [15, 30]] as Cond['value'][]) {
      const triggers = synthesizeTriggers(
        one({ field: 'current_pause_minutes', operator: 'gte', value })
      );
      expect(heldFor(triggers)).toEqual([
        expect.objectContaining({ enabled: false, params: { minutes: 30, measure: 'current' } }),
      ]);
    }
  });

  it('warns with the rule, field and value it could not turn into a node', () => {
    synthesizeTriggers(
      one({ field: 'current_pause_minutes', operator: 'gte', value: 2000 }),
      'rule-1'
    );

    expect(mockWarn).toHaveBeenCalledWith(
      'Condition threshold outside the trigger range; node stamped disabled',
      { automationId: 'rule-1', field: 'current_pause_minutes', operator: 'gte', value: 2000 }
    );
  });

  it('says nothing when every threshold lands', () => {
    synthesizeTriggers(one({ field: 'current_pause_minutes', operator: 'gte', value: 15 }));
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('synthesizeTriggers inactive_for params', () => {
  it('takes the days from the first enabled inactive_days condition', () => {
    const triggers = synthesizeTriggers(
      conditions(
        [{ field: 'inactive_days', operator: 'gte', value: 30, enabled: false }],
        [{ field: 'inactive_days', operator: 'gte', value: 90 }]
      )
    );
    expect(triggers.map((n) => n.type)).toEqual(['account.inactive_for']);
    expect(inactiveFor(triggers)).toEqual([
      { id: expect.any(String), type: 'account.inactive_for', enabled: true, params: { days: 90 } },
    ]);
  });

  it('a non-numeric threshold falls back to thirty days, disabled, and warns', () => {
    const triggers = synthesizeTriggers(
      one({ field: 'inactive_days', operator: 'in', value: [30, 60] }),
      'rule-2'
    );
    expect(inactiveFor(triggers)).toEqual([
      expect.objectContaining({ enabled: false, params: { days: 30 } }),
    ]);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), {
      automationId: 'rule-2',
      field: 'inactive_days',
      operator: 'in',
      value: [30, 60],
    });
  });
});

describe('carryTriggerIds', () => {
  it('the first node of a type keeps its id and the rest are new', () => {
    const existing = synthesizeTriggers(
      one({ field: 'current_pause_minutes', operator: 'gte', value: 15 })
    );
    const priorHeldForId = heldFor(existing)[0]?.id;
    const priorPausedId = nodesOf(existing, 'session.paused')[0]?.id;

    const next = carryTriggerIds(
      synthesizeTriggers(
        conditions(
          [{ field: 'current_pause_minutes', operator: 'gte', value: 20 }],
          [{ field: 'total_pause_minutes', operator: 'gte', value: 45 }]
        )
      ),
      existing
    );

    const kept = heldFor(next);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({
      id: priorHeldForId,
      params: { minutes: 20, measure: 'current' },
    });
    expect(kept[1]?.id).not.toBe(priorHeldForId);
    expect(nodesOf(next, 'session.paused')[0]?.id).toBe(priorPausedId);
  });

  it('does not hand the same id to two nodes when the prior list held two', () => {
    const existing = synthesizeTriggers(
      conditions(
        [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }],
        [{ field: 'total_pause_minutes', operator: 'gte', value: 45 }]
      )
    );
    const next = carryTriggerIds(
      synthesizeTriggers(
        conditions(
          [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }],
          [{ field: 'total_pause_minutes', operator: 'gte', value: 60 }]
        )
      ),
      existing
    );
    const ids = next.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(heldFor(next)[0]?.id).toBe(heldFor(existing)[0]?.id);
  });
});

/** Two catalogs name the same six columns; a field added to one has to reach the other. */
describe('media quality catalogs', () => {
  it('offers a from and a to variable for every quality field the payload carries', () => {
    const named = (side: 'from' | 'to'): string[] =>
      TRIGGERS['media.upgraded'].variables
        .filter((variable) => variable.startsWith(`media.${side}.`))
        .map((variable) => variable.slice(`media.${side}.`.length));

    expect(named('from')).toEqual([...MEDIA_QUALITY_FIELDS]);
    expect(named('to')).toEqual([...MEDIA_QUALITY_FIELDS]);
  });
});
