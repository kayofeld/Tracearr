import { beforeAll, describe, expect, it } from 'vitest';
import { i18n, initI18n } from '@tracearr/translations';
import { AUTOMATION_DESCRIPTION_MAX, AUTOMATION_NAME_MAX, type Automation } from '@tracearr/shared';
import { SENTENCE_SECTIONS, type Translate } from '@/lib/automations';
import { builderReducer, builderStateFrom, emptyBuilderState } from '../builderReducer';
import { ApiError } from '@/lib/api';
import { BUILDER_SECTIONS, builderIssues, issuesByNode, serverIssues } from '../validation';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Stored',
    description: null,
    kind: 'notification',
    severity: null,
    triggers: [{ id: '11111111-1111-4111-8111-111111111111', type: 'server.down', enabled: true }],
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

describe('BUILDER_SECTIONS', () => {
  it('answers to the same ids the sentence addresses steps by', () => {
    for (const [key, id] of Object.entries(SENTENCE_SECTIONS)) {
      expect(BUILDER_SECTIONS[key as keyof typeof SENTENCE_SECTIONS]).toBe(id);
    }
  });
});

describe('builderIssues', () => {
  it('asks for a name against the name field', () => {
    const state = builderReducer(emptyBuilderState(), {
      type: 'addTrigger',
      triggerType: 'session.started',
    });

    const issues = builderIssues(state, t);

    expect(issues).toContainEqual({
      nodeId: BUILDER_SECTIONS.name,
      message: 'Give this automation a name',
    });
  });

  it('sends a length complaint to the field it is about, not to the name by default', () => {
    const named = builderReducer(emptyBuilderState(), {
      type: 'setName',
      value: 'n'.repeat(AUTOMATION_NAME_MAX + 1),
    });
    const noted = builderReducer(named, {
      type: 'setDescription',
      value: 'd'.repeat(AUTOMATION_DESCRIPTION_MAX + 1),
    });

    const issues = builderIssues(noted, t);

    expect(issues).toContainEqual({
      nodeId: BUILDER_SECTIONS.name,
      message: `At most ${AUTOMATION_NAME_MAX} characters`,
    });
    expect(issues).toContainEqual({
      nodeId: BUILDER_SECTIONS.description,
      message: `At most ${AUTOMATION_DESCRIPTION_MAX} characters`,
    });
  });

  it('asks for a trigger when nothing is switched on', () => {
    const named = builderReducer(emptyBuilderState(), { type: 'setName', value: 'Nightly' });
    const added = builderReducer(named, { type: 'addTrigger', triggerType: 'session.started' });
    const id = added.triggers[0]?.id ?? '';
    const off = builderReducer(added, { type: 'toggleNode', id });

    expect(builderIssues(added, t)).toEqual([]);
    expect(builderIssues(off, t)).toEqual([
      {
        nodeId: BUILDER_SECTIONS.triggers,
        message: 'Add what starts this, or switch one back on',
      },
    ]);
  });

  it('names the trigger a condition is not available for, on that condition row', () => {
    const state = builderStateFrom(
      automation({
        conditions: {
          groups: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              conditions: [
                {
                  id: '55555555-5555-4555-8555-555555555555',
                  field: 'trust_score',
                  operator: 'lt',
                  value: 50,
                },
              ],
            },
          ],
        },
      })
    );

    const issues = builderIssues(state, t);

    expect(issues).toContainEqual({
      nodeId: '55555555-5555-4555-8555-555555555555',
      message: 'Not available for: A server goes down',
      tone: 'warning',
    });
  });

  it('names the bounds when a threshold lands outside them', () => {
    const minutes = builderStateFrom(
      automation({
        triggers: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            type: 'session.held_for',
            enabled: true,
            params: { minutes: 5000, measure: 'current' },
          },
        ],
      })
    );
    const days = builderStateFrom(
      automation({
        triggers: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            type: 'account.inactive_for',
            enabled: true,
            params: { days: 9000 },
          },
        ],
      })
    );

    expect(builderIssues(minutes, t)).toContainEqual({
      nodeId: '66666666-6666-4666-8666-666666666666',
      message: 'Between 1 and 1440 minutes',
    });
    expect(builderIssues(days, t)).toContainEqual({
      nodeId: '77777777-7777-4777-8777-777777777777',
      message: 'Between 1 and 3650 days',
    });
  });

  it('takes a stored list field compared with is against one value', () => {
    const state = builderStateFrom(
      automation({
        triggers: [
          { id: '11111111-1111-4111-8111-111111111111', type: 'session.started', enabled: true },
        ],
        conditions: {
          groups: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              conditions: [
                {
                  id: '55555555-5555-4555-8555-555555555555',
                  field: 'country',
                  operator: 'eq',
                  value: 'US',
                },
              ],
            },
          ],
        },
      })
    );

    expect(builderIssues(state, t)).toEqual([]);
  });

  it('flags a scope that names no target', () => {
    const named = builderReducer(emptyBuilderState(), { type: 'setName', value: 'Nightly' });
    const added = builderReducer(named, { type: 'addTrigger', triggerType: 'session.started' });
    const scoped = builderReducer(added, {
      type: 'setScope',
      value: { mode: 'server', serverId: '' },
    });

    expect(builderIssues(scoped, t).map((issue) => issue.nodeId)).toEqual([BUILDER_SECTIONS.scope]);
  });
});

describe('builderIssues actions', () => {
  it('asks a send for a destination on the action that has none', () => {
    const state = builderStateFrom(
      automation({
        triggers: [
          { id: '11111111-1111-4111-8111-111111111111', type: 'session.started', enabled: true },
        ],
        actions: { actions: [{ id: 'send-1', type: 'send', to: [] }] },
      })
    );

    expect(builderIssues(state, t)).toContainEqual({
      nodeId: 'send-1',
      message: 'Pick at least one destination',
    });
  });
});

describe('serverIssues', () => {
  it('points a rejected field at the row that holds it', () => {
    const state = builderStateFrom(
      automation({
        conditions: {
          groups: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              conditions: [
                {
                  id: '55555555-5555-4555-8555-555555555555',
                  field: 'trust_score',
                  operator: 'lt',
                  value: 50,
                },
              ],
            },
          ],
        },
      })
    );
    const error = new ApiError('Validation failed', 400, {
      details: {
        fields: [
          { field: 'body.conditions.groups.0.conditions.0.field', message: 'not available' },
        ],
      },
    });

    expect(serverIssues(state, error, t)).toEqual([
      {
        nodeId: '55555555-5555-4555-8555-555555555555',
        message: 'Not available for: A server goes down',
        tone: 'warning',
      },
    ]);
  });

  it('ignores anything that is not a validation failure', () => {
    expect(serverIssues(emptyBuilderState(), new Error('offline'), t)).toEqual([]);
  });
});

describe('issuesByNode', () => {
  it('gathers every message under the node it belongs to', () => {
    const issues = [
      { nodeId: '55555555-5555-4555-8555-555555555555', message: 'first' },
      { nodeId: '55555555-5555-4555-8555-555555555555', message: 'second' },
      { nodeId: BUILDER_SECTIONS.name, message: 'named' },
    ];

    const byNode = issuesByNode(issues);

    expect(byNode.get('55555555-5555-4555-8555-555555555555')).toEqual([issues[0], issues[1]]);
    expect(byNode.get(BUILDER_SECTIONS.name)).toEqual([issues[2]]);
    expect(byNode.get('nothing')).toBeUndefined();
  });
});
