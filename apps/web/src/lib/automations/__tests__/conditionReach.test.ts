import { beforeAll, describe, expect, it } from 'vitest';
import { i18n, initI18n } from '@tracearr/translations';
import type { AutomationConditions, Condition, TriggerNode } from '@tracearr/shared';
import { orphaningTriggers, unreachableNote } from '../conditionReach';
import type { Translate } from '../conditionFields';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

function heldFor(minutes: number, measure: 'current' | 'total' = 'current'): TriggerNode {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'session.held_for',
    enabled: true,
    params: { minutes, measure },
  };
}

function pause(value: number, operator: Condition['operator'] = 'gte'): Condition {
  return { id: 'c-1', field: 'current_pause_minutes', operator, value };
}

/** Only the pause condition itself: nothing else can flip, so nothing re-checks. */
function alone(condition: Condition): AutomationConditions {
  return { groups: [{ id: 'g-1', conditions: [condition] }] };
}

describe('unreachableNote', () => {
  it('says so when the threshold sits past the trigger that would fire it', () => {
    const condition = pause(60);

    expect(unreachableNote(t, [heldFor(30)], condition, alone(condition))).toBe(
      'This can never pass. The trigger already fires at 30 minutes.'
    );
  });

  it('leaves the boundary alone, because the trigger fires a second past it', () => {
    const gt = pause(30, 'gt');
    const gte = pause(30);

    expect(unreachableNote(t, [heldFor(30)], gt, alone(gt))).toBeNull();
    expect(unreachableNote(t, [heldFor(30)], gte, alone(gte))).toBeNull();
  });

  it('stays quiet while another condition holds the check open', () => {
    const condition = pause(60);
    const withCompanion: AutomationConditions = {
      groups: [
        {
          id: 'g-1',
          conditions: [condition, { id: 'c-2', field: 'trust_score', operator: 'lt', value: 50 }],
        },
      ],
    };

    expect(unreachableNote(t, [heldFor(30)], condition, withCompanion)).toBeNull();
  });

  it('ignores a trigger counting the other measure', () => {
    const condition = pause(60);

    expect(unreachableNote(t, [heldFor(30, 'total')], condition, alone(condition))).toBeNull();
  });

  it('ignores a trigger that is switched off, and a definition without one', () => {
    const condition = pause(60);
    const off = { ...heldFor(30), enabled: false };

    expect(unreachableNote(t, [off], condition, alone(condition))).toBeNull();
    expect(unreachableNote(t, [], condition, alone(condition))).toBeNull();
  });

  it('leaves inactivity alone: the sweep re-polls, so the day count keeps growing', () => {
    const inactiveFor: TriggerNode = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'account.inactive_for',
      enabled: true,
      params: { days: 30 },
    };
    const condition: Condition = { id: 'c-1', field: 'inactive_days', operator: 'gte', value: 90 };

    expect(unreachableNote(t, [inactiveFor], condition, alone(condition))).toBeNull();
  });

  it('has nothing to say about a field that keeps no clock', () => {
    const condition: Condition = { id: 'c-1', field: 'trust_score', operator: 'gte', value: 90 };

    expect(unreachableNote(t, [heldFor(30)], condition, alone(condition))).toBeNull();
  });
});

describe('orphaningTriggers', () => {
  it('names the enabled trigger that cannot supply the field', () => {
    const down: TriggerNode = {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'server.down',
      enabled: true,
    };

    expect(orphaningTriggers(t, [down], 'trust_score')).toEqual(['A server goes down']);
    expect(orphaningTriggers(t, [down], 'server_id')).toEqual([]);
    expect(orphaningTriggers(t, [{ ...down, enabled: false }], 'trust_score')).toEqual([]);
  });
});
