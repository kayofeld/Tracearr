import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Automation, TriggerNode } from '@tracearr/shared';
import {
  builderReducer,
  builderStateFrom,
  emptyBuilderState,
  toCreateInput,
  type BuilderState,
} from '../builderReducer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function added(...types: TriggerNode['type'][]): BuilderState {
  return types.reduce(
    (state, triggerType) => builderReducer(state, { type: 'addTrigger', triggerType }),
    emptyBuilderState()
  );
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Stored',
    description: 'kept',
    kind: 'notification',
    severity: null,
    triggers: [
      { id: '11111111-1111-4111-8111-111111111111', type: 'session.started', enabled: true },
    ],
    conditions: { groups: [] },
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef: null,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('builderReducer triggers', () => {
  it('stamps a new trigger with an id and switches it on', () => {
    const state = added('session.started');

    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0]?.id).toMatch(UUID);
    expect(state.triggers[0]?.enabled).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it('gives the two parameterised triggers their defaults', () => {
    const state = added('session.held_for', 'account.inactive_for');

    expect(state.triggers[0]).toMatchObject({
      type: 'session.held_for',
      params: { minutes: 30, measure: 'current' },
    });
    expect(state.triggers[1]).toMatchObject({
      type: 'account.inactive_for',
      params: { days: 30 },
    });
  });

  it('patches one held_for param and leaves the other alone', () => {
    const state = added('session.held_for');
    const id = state.triggers[0]?.id ?? '';

    const next = builderReducer(state, { type: 'setTriggerParam', id, patch: { minutes: 90 } });

    expect(next.triggers[0]).toMatchObject({ params: { minutes: 90, measure: 'current' } });

    const measured = builderReducer(next, {
      type: 'setTriggerParam',
      id,
      patch: { measure: 'total' },
    });

    expect(measured.triggers[0]).toMatchObject({ params: { minutes: 90, measure: 'total' } });
  });
});

describe('builderReducer nodes', () => {
  it('toggles a trigger by id', () => {
    const state = added('session.started');
    const id = state.triggers[0]?.id ?? '';

    expect(builderReducer(state, { type: 'toggleNode', id }).triggers[0]?.enabled).toBe(false);
  });

  it('removes a trigger by id and leaves its neighbour', () => {
    const state = added('session.started', 'session.paused');
    const id = state.triggers[0]?.id ?? '';

    const next = builderReducer(state, { type: 'removeNode', id });

    expect(next.triggers.map((trigger) => trigger.type)).toEqual(['session.paused']);
  });

  it('reaches a condition row nested in an if branch', () => {
    const loaded = builderStateFrom(
      automation({
        actions: {
          actions: [
            {
              id: 'if-1',
              type: 'if',
              conditions: {
                groups: [
                  {
                    id: 'g-1',
                    conditions: [{ id: 'c-1', field: 'trust_score', operator: 'lt', value: 50 }],
                  },
                ],
              },
              then: [{ id: 'kill-1', type: 'kill_stream' }],
              else: [],
            },
          ],
        },
      })
    );

    const toggled = builderReducer(loaded, { type: 'toggleNode', id: 'c-1' });
    const branch = toggled.actions.actions[0];

    expect(branch?.type === 'if' && branch.conditions.groups[0]?.conditions[0]?.enabled).toBe(
      false
    );

    const removed = builderReducer(loaded, { type: 'removeNode', id: 'kill-1' });
    const after = removed.actions.actions[0];

    expect(after?.type === 'if' && after.then).toEqual([]);
  });
});

describe('builderReducer conditions', () => {
  function withGroup() {
    const state = builderReducer(added('session.started'), { type: 'addConditionGroup' });
    return { state, groupId: state.conditions.groups[0]?.id ?? '' };
  }

  it('opens a group on all-of-these with one row the triggers can supply', () => {
    const { state } = withGroup();
    const group = state.conditions.groups[0];

    expect(group?.match).toBe('all');
    expect(group?.id).toMatch(UUID);
    expect(group?.conditions).toHaveLength(1);
    expect(group?.conditions[0]).toMatchObject({ field: 'concurrent_streams', enabled: true });
  });

  it('starts a row on a field an account trigger supplies', () => {
    const state = builderReducer(added('account.inactive_for'), { type: 'addConditionGroup' });

    expect(state.conditions.groups[0]?.conditions[0]?.field).toBe('inactive_days');
  });

  it('adds a row to the named group and writes the logic', () => {
    const { state, groupId } = withGroup();

    const two = builderReducer(state, { type: 'addCondition', groupId });
    expect(two.conditions.groups[0]?.conditions).toHaveLength(2);

    const any = builderReducer(two, { type: 'setConditionMatch', groupId, match: 'any' });
    expect(any.conditions.groups[0]?.match).toBe('any');
  });

  it('replaces one row and leaves its id and switch alone', () => {
    const { state } = withGroup();
    const id = state.conditions.groups[0]?.conditions[0]?.id ?? '';

    const next = builderReducer(state, {
      type: 'setCondition',
      id,
      condition: { id, enabled: true, field: 'trust_score', operator: 'lt', value: 40 },
    });

    expect(next.conditions.groups[0]?.conditions[0]).toMatchObject({
      id,
      field: 'trust_score',
      value: 40,
    });
  });

  it('takes the group with the last row that leaves it', () => {
    const { state } = withGroup();
    const id = state.conditions.groups[0]?.conditions[0]?.id ?? '';

    expect(builderReducer(state, { type: 'removeNode', id }).conditions.groups).toEqual([]);
  });
});

describe('builderReducer actions', () => {
  function withActions() {
    const one = builderReducer(added('session.started'), {
      type: 'addAction',
      actionType: 'send',
    });
    return builderReducer(one, { type: 'addAction', actionType: 'kill_stream' });
  }

  it('stamps a new action and gives it the defaults of its type', () => {
    const state = withActions();

    expect(state.actions.actions[0]).toMatchObject({ type: 'send', to: [], enabled: true });
    expect(state.actions.actions[0]?.id).toMatch(UUID);
  });

  it('moves a row within the list it sits in', () => {
    const state = withActions();
    const id = state.actions.actions[1]?.id ?? '';

    const moved = builderReducer(state, { type: 'moveAction', id, delta: -1 });

    expect(moved.actions.actions.map((action) => action.type)).toEqual(['kill_stream', 'send']);
  });

  it('adds a leaf to the branch it was asked for', () => {
    const withIf = builderReducer(added('session.started'), {
      type: 'addAction',
      actionType: 'if',
    });
    const ifId = withIf.actions.actions[0]?.id ?? '';

    const branched = builderReducer(withIf, {
      type: 'addAction',
      actionType: 'kill_stream',
      branch: { ifId, side: 'else' },
    });
    const branch = branched.actions.actions[0];

    expect(branch?.type === 'if' && branch.else.map((leaf) => leaf.type)).toEqual(['kill_stream']);
  });

  it('takes the server an account scope sits on from the row it loaded', () => {
    const loaded = builderStateFrom(
      automation({
        serverUserId: '99999999-9999-4999-8999-999999999999',
        scopeRef: {
          kind: 'account',
          id: '99999999-9999-4999-8999-999999999999',
          name: 'connor',
          serverId: '88888888-8888-4888-8888-888888888888',
          serverName: 'Beehive',
        },
      })
    );

    expect(loaded.scope).toEqual({
      mode: 'account',
      serverId: '88888888-8888-4888-8888-888888888888',
      serverUserId: '99999999-9999-4999-8999-999999999999',
    });
  });

  it('gives a stored node without an id one to be addressed by', () => {
    const loaded = builderStateFrom(
      automation({
        conditions: {
          groups: [{ conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] }],
        },
        actions: { actions: [{ type: 'send', to: ['d1'] }] },
      })
    );

    expect(loaded.conditions.groups[0]?.id).toMatch(UUID);
    expect(loaded.conditions.groups[0]?.conditions[0]?.id).toMatch(UUID);
    expect(loaded.actions.actions[0]?.id).toMatch(UUID);
  });
});

describe('builderReducer lifecycle', () => {
  it('starts clean, dirties on a change and comes back clean on load', () => {
    expect(emptyBuilderState().dirty).toBe(false);

    const typed = builderReducer(emptyBuilderState(), { type: 'setName', value: 'Nightly' });
    expect(typed.dirty).toBe(true);

    const loaded = builderReducer(typed, { type: 'load', automation: automation() });
    expect(loaded.dirty).toBe(false);
    expect(loaded.name).toBe('Stored');
  });

  it('clears dirty once saved', () => {
    const typed = builderReducer(emptyBuilderState(), { type: 'setName', value: 'Nightly' });

    expect(builderReducer(typed, { type: 'saved' }).dirty).toBe(false);
  });
});

describe('toCreateInput', () => {
  it('carries the triggers and hands back conditions and actions untouched', () => {
    const stored = automation({
      conditions: {
        groups: [
          {
            id: 'g-1',
            conditions: [{ id: 'c-1', field: 'trust_score', operator: 'lt', value: 50 }],
          },
        ],
      },
      actions: { actions: [{ id: 'send-1', type: 'send', to: ['d1'] }] },
    });
    const state = builderStateFrom(stored);

    const input = toCreateInput(state);

    expect(input.triggers).toEqual(stored.triggers);
    expect(input.conditions).toEqual(stored.conditions);
    expect(input.actions).toEqual(stored.actions);
    expect(input.description).toBe('kept');
  });

  it('drops the severity a notification never uses', () => {
    const state = builderReducer(emptyBuilderState(), { type: 'setKind', value: 'notification' });

    expect(toCreateInput(state).severity).toBeNull();
    expect(
      toCreateInput(builderReducer(state, { type: 'setKind', value: 'policy' })).severity
    ).toBe('warning');
  });
});

describe('builderReducer without crypto.randomUUID', () => {
  // A LAN address over plain http is not a secure context, so the browser omits randomUUID.
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  afterEach(() => vi.unstubAllGlobals());

  it('still stamps ids the server accepts as uuids', () => {
    vi.stubGlobal('crypto', { getRandomValues });
    expect(crypto.randomUUID).toBeUndefined();

    const stored = builderStateFrom(
      automation({
        conditions: {
          groups: [
            {
              enabled: true,
              match: 'all',
              conditions: [
                { enabled: true, field: 'concurrent_streams', operator: 'gte', value: 2 },
              ],
            },
          ],
        },
      })
    );
    const added = builderReducer(stored, { type: 'addTrigger', triggerType: 'session.started' });

    const ids = [
      stored.conditions.groups[0]?.id,
      stored.conditions.groups[0]?.conditions[0]?.id,
      added.triggers[1]?.id,
    ];
    for (const id of ids) expect(z.uuid().safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });
});
