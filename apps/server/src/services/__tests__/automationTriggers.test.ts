import { describe, expect, it } from 'vitest';
import type { ConditionField, AutomationConditions } from '@tracearr/shared';
import { stampNodes, synthesizeTriggers } from '../automations/triggers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One field per group, which is how the sniffing predicates walked legacy rows. */
const conditionsFor = (...fields: ConditionField[]): AutomationConditions => ({
  groups: fields.map((field) => ({ conditions: [{ field, operator: 'gt', value: 1 }] })),
});

const types = (conditions: AutomationConditions | null) =>
  synthesizeTriggers(conditions).map((trigger) => trigger.type);

describe('synthesizeTriggers', () => {
  it('gives every node a uuid and an enabled flag', () => {
    const triggers = synthesizeTriggers(conditionsFor('is_transcoding'));
    for (const trigger of triggers) {
      expect(trigger.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(trigger.enabled).toBe(true);
    }
    expect(new Set(triggers.map((t) => t.id)).size).toBe(triggers.length);
  });

  it('adds the transcode edge to a transcode rule', () => {
    expect(types(conditionsFor('is_transcoding'))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
    expect(types(conditionsFor('is_transcode_downgrade'))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
    expect(types(conditionsFor('output_resolution'))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
  });

  it('keeps the transcode edge when a transcode field sits beside non-transcode ones', () => {
    expect(types(conditionsFor('is_transcoding', 'source_resolution'))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
  });

  it('adds no edge for fields that do not move mid-session', () => {
    expect(types(conditionsFor('source_resolution'))).toEqual(['session.started']);
    expect(types(conditionsFor('concurrent_streams', 'trust_score'))).toEqual(['session.started']);
  });

  it('adds both pause edges to a pause rule', () => {
    expect(types(conditionsFor('current_pause_minutes'))).toEqual([
      'session.started',
      'session.paused',
      'session.held_for',
    ]);
    expect(types(conditionsFor('total_pause_minutes'))).toEqual([
      'session.started',
      'session.paused',
      'session.held_for',
    ]);
  });

  it('routes an inactivity rule to the account trigger and drops session.started', () => {
    expect(types(conditionsFor('inactive_days'))).toEqual(['account.inactive_for']);
  });

  it('keeps the pause edges on a rule mixing inactive_days with pause fields', () => {
    expect(types(conditionsFor('inactive_days', 'current_pause_minutes'))).toEqual([
      'session.paused',
      'session.held_for',
      'account.inactive_for',
    ]);
  });

  it('leaves an account-attribute rule on session.started alone', () => {
    expect(types(conditionsFor('trust_score'))).toEqual(['session.started']);
  });

  it('reads every condition in a group, not just the first', () => {
    const conditions: AutomationConditions = {
      groups: [
        {
          conditions: [
            { field: 'concurrent_streams', operator: 'gt', value: 2 },
            { field: 'total_pause_minutes', operator: 'gt', value: 30 },
          ],
        },
      ],
    };
    expect(types(conditions)).toEqual(['session.started', 'session.paused', 'session.held_for']);
  });

  it('falls back to session.started for empty and missing conditions', () => {
    expect(types({ groups: [] })).toEqual(['session.started']);
    expect(types(null)).toEqual(['session.started']);
    expect(synthesizeTriggers(undefined).map((t) => t.type)).toEqual(['session.started']);
  });
});

describe('stampNodes', () => {
  const existing = 'b2c3d4e5-6f70-4a1b-8c9d-0e1f2a3b4c5d';

  it('keeps the id and enabled flag a node already carries', () => {
    const stamped = stampNodes({
      conditions: {
        groups: [
          {
            conditions: [
              { field: 'trust_score', operator: 'lt', value: 50, id: existing, enabled: false },
            ],
          },
        ],
      },
      actions: { actions: [{ type: 'trust', mode: 'reset', id: existing, enabled: false }] },
    });

    expect(stamped.conditions?.groups[0]?.conditions[0]).toMatchObject({
      id: existing,
      enabled: false,
    });
    expect(stamped.actions.actions[0]).toMatchObject({ id: existing, enabled: false });
  });

  it('fills a missing id and defaults enabled to true', () => {
    const stamped = stampNodes({
      conditions: {
        groups: [
          { conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] },
          { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
        ],
      },
      actions: {
        actions: [
          { type: 'trust', mode: 'reset' },
          { type: 'message_client', message: 'hi' },
        ],
      },
    });

    const nodes = [
      ...(stamped.conditions?.groups ?? []).flatMap((group) => group.conditions),
      ...stamped.actions.actions,
    ];
    for (const node of nodes) {
      expect(node.id).toMatch(UUID);
      expect(node.enabled).toBe(true);
    }
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
  });

  it('reaches a group, a branch and the leaves on both of its sides', () => {
    const stamped = stampNodes({
      conditions: {
        groups: [{ conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] }],
      },
      actions: {
        actions: [
          {
            type: 'if',
            conditions: {
              groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
            },
            then: [{ type: 'trust', mode: 'reset' }],
            else: [{ type: 'message_client', message: 'hi' }],
          },
        ],
      },
    });

    const branch = stamped.actions.actions[0];
    if (branch?.type !== 'if') throw new Error('the branch did not survive stamping');
    const stampedNodes = [
      ...(stamped.conditions?.groups ?? []),
      branch,
      ...branch.conditions.groups,
      ...branch.conditions.groups.flatMap((group) => group.conditions),
      ...branch.then,
      ...branch.else,
    ];
    for (const node of stampedNodes) {
      expect(node.id).toMatch(UUID);
      expect(node.enabled).toBe(true);
    }
  });

  it('leaves null conditions null and treats missing actions as none', () => {
    expect(stampNodes({ conditions: null, actions: null })).toEqual({
      conditions: null,
      actions: { actions: [] },
    });
  });

  it('does not mutate its input', () => {
    const conditions: AutomationConditions = {
      groups: [{ conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] }],
    };
    stampNodes({ conditions, actions: { actions: [{ type: 'trust', mode: 'reset' }] } });
    expect(conditions.groups[0]?.conditions[0]).toEqual({
      field: 'trust_score',
      operator: 'lt',
      value: 50,
    });
  });
});
