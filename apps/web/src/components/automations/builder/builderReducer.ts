/**
 * The builder page's whole state. Conditions and actions are held as the API sent
 * them so an edit started from the page saves back everything it loaded.
 */

import type { Dispatch } from 'react';
import {
  contextOf,
  fieldsAvailableFor,
  type Action,
  type ActionType,
  type Automation,
  type AutomationActions,
  type AutomationConditions,
  type AutomationKind,
  type Condition,
  type ConditionGroup,
  type ConditionMatch,
  type CreateAutomationInput,
  type LeafAction,
  type TriggerNode,
  type TriggerType,
  type ViolationSeverity,
} from '@tracearr/shared';
import {
  canEnforceAcrossServers,
  createDefaultAction,
  defaultParamsForField,
  getDefaultOperatorForField,
  getDefaultValueForField,
  scopeFromAutomation,
  scopeToPayload,
  type AutomationDraft,
  type AutomationScope,
} from '@/lib/automations';
import { randomUuid } from '@/lib/utils';

export interface BuilderState {
  name: string;
  description: string;
  kind: AutomationKind;
  /** Kept across a switch to notification so switching back restores the picked severity. */
  severity: ViolationSeverity;
  isActive: boolean;
  scope: AutomationScope;
  enforceAcrossServers: boolean;
  triggers: TriggerNode[];
  conditions: AutomationConditions;
  actions: AutomationActions;
  dirty: boolean;
}

/** Only the two parameterised triggers carry anything; a patch names one part of it. */
export interface TriggerParamPatch {
  minutes?: number;
  measure?: 'current' | 'total';
  days?: number;
}

/** Where a new action lands when it belongs to one side of an `if`. */
export interface BranchTarget {
  ifId: string;
  side: 'then' | 'else';
}

export type BuilderAction =
  | { type: 'setName'; value: string }
  | { type: 'setDescription'; value: string }
  | { type: 'setKind'; value: AutomationKind }
  | { type: 'setSeverity'; value: ViolationSeverity }
  | { type: 'setActive'; value: boolean }
  | { type: 'setScope'; value: AutomationScope }
  | { type: 'setEnforceAcrossServers'; value: boolean }
  | { type: 'addTrigger'; triggerType: TriggerType }
  | { type: 'setTriggerParam'; id: string; patch: TriggerParamPatch }
  | { type: 'addConditionGroup'; ifId?: string }
  | { type: 'addCondition'; groupId: string }
  | { type: 'setConditionMatch'; groupId: string; match: ConditionMatch }
  | { type: 'setCondition'; id: string; condition: Condition }
  | { type: 'addAction'; actionType: ActionType; branch?: BranchTarget }
  | { type: 'setAction'; id: string; action: Action }
  | { type: 'moveAction'; id: string; delta: number }
  | { type: 'toggleNode'; id: string }
  | { type: 'removeNode'; id: string }
  | { type: 'load'; automation: Automation }
  | { type: 'saved' };

export type BuilderDispatch = Dispatch<BuilderAction>;

const HELD_FOR_DEFAULTS = { minutes: 30, measure: 'current' } as const;
const INACTIVE_FOR_DEFAULTS = { days: 30 } as const;

/** The bounds `heldForParamsSchema` and `inactiveForParamsSchema` enforce, for the steppers
 * that offer them and the message that names them when a typed value lands outside. */
export const TRIGGER_PARAM_BOUNDS = {
  minutes: { min: 1, max: 1440 },
  days: { min: 1, max: 3650 },
} as const;

/** Every node in builder state is stamped, so a row can address the optional id. */
export function idOf(node: { id?: string }): string {
  return node.id ?? '';
}

/** The element id a node's row carries, so the sentence and the error count can reach it. */
export function nodeDomId(nodeId: string): string {
  return `automation-node-${nodeId}`;
}

export function emptyBuilderState(): BuilderState {
  return {
    name: '',
    description: '',
    kind: 'policy',
    severity: 'warning',
    isActive: true,
    scope: { mode: 'global' },
    enforceAcrossServers: false,
    triggers: [],
    conditions: { groups: [] },
    actions: { actions: [] },
    dirty: false,
  };
}

/** Every node the page shows needs an id to be addressed by; a stored one may predate them. */
function stampConditions(conditions: AutomationConditions): AutomationConditions {
  return {
    groups: conditions.groups.map((group) => ({
      ...group,
      id: group.id ?? randomUuid(),
      conditions: group.conditions.map((condition) => ({
        ...condition,
        id: condition.id ?? randomUuid(),
      })),
    })),
  };
}

function stampActions(actions: AutomationActions): AutomationActions {
  return {
    actions: actions.actions.map((action) => {
      const stamped = { ...action, id: action.id ?? randomUuid() };
      if (stamped.type !== 'if') return stamped;
      return {
        ...stamped,
        conditions: stampConditions(stamped.conditions),
        then: stamped.then.map((leaf) => ({ ...leaf, id: leaf.id ?? randomUuid() })),
        else: stamped.else.map((leaf) => ({ ...leaf, id: leaf.id ?? randomUuid() })),
      };
    }),
  };
}

/** A stored row and a draft the reader has not saved yet seed the page the same way. */
export function builderStateFrom(automation: AutomationDraft): BuilderState {
  return {
    name: automation.name,
    description: automation.description ?? '',
    kind: automation.kind,
    severity: automation.severity ?? 'warning',
    isActive: automation.isActive,
    scope: scopeFromAutomation(automation, automation.scopeRef?.serverId),
    enforceAcrossServers: automation.enforceAcrossServers,
    triggers: automation.triggers,
    conditions: stampConditions(automation.conditions),
    actions: stampActions(automation.actions),
    dirty: false,
  };
}

export function toCreateInput(state: BuilderState): CreateAutomationInput {
  return {
    name: state.name.trim(),
    description: state.description.trim() || null,
    kind: state.kind,
    severity: state.kind === 'policy' ? state.severity : null,
    isActive: state.isActive,
    triggers: state.triggers,
    conditions: state.conditions,
    actions: state.actions,
    ...scopeToPayload(state.scope),
    enforceAcrossServers: canEnforceAcrossServers(state.scope, state.conditions)
      ? state.enforceAcrossServers
      : false,
  };
}

function newTrigger(triggerType: TriggerType): TriggerNode {
  const node = { id: randomUuid(), enabled: true };
  if (triggerType === 'session.held_for') {
    return { ...node, type: triggerType, params: { ...HELD_FOR_DEFAULTS } };
  }
  if (triggerType === 'account.inactive_for') {
    return { ...node, type: triggerType, params: { ...INACTIVE_FOR_DEFAULTS } };
  }
  return { ...node, type: triggerType };
}

/** A new row starts on a field the triggers can actually supply. */
function newCondition(triggers: readonly TriggerNode[]): Condition {
  const field = fieldsAvailableFor(contextOf(triggers))[0] ?? 'concurrent_streams';
  const params = defaultParamsForField(field);
  return {
    id: randomUuid(),
    enabled: true,
    field,
    operator: getDefaultOperatorForField(field),
    value: getDefaultValueForField(field),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

function newGroup(triggers: readonly TriggerNode[]): ConditionGroup {
  return {
    id: randomUuid(),
    enabled: true,
    match: 'all',
    conditions: [newCondition(triggers)],
  };
}

function newAction(actionType: ActionType): Action {
  const node = { id: randomUuid(), enabled: true };
  if (actionType === 'if') {
    return { ...node, type: 'if', conditions: { groups: [] }, then: [], else: [] };
  }
  return { ...createDefaultAction(actionType), ...node };
}

function withParams(trigger: TriggerNode, patch: TriggerParamPatch): TriggerNode {
  if (trigger.type === 'session.held_for') {
    return {
      ...trigger,
      params: {
        minutes: patch.minutes ?? trigger.params.minutes,
        measure: patch.measure ?? trigger.params.measure,
      },
    };
  }
  if (trigger.type === 'account.inactive_for') {
    return { ...trigger, params: { days: patch.days ?? trigger.params.days } };
  }
  return trigger;
}

/** One write against whichever group list holds the node, page-level or inside an `if`. */
type ConditionWrite =
  | { kind: 'add'; groupId: string; condition: Condition }
  | { kind: 'match'; groupId: string; match: ConditionMatch }
  | { kind: 'set'; id: string; condition: Condition };

function writeConditions(
  conditions: AutomationConditions,
  write: ConditionWrite
): AutomationConditions {
  return {
    groups: conditions.groups.map((group) => {
      if (write.kind === 'set') {
        return {
          ...group,
          conditions: group.conditions.map((condition) =>
            condition.id === write.id ? { ...write.condition, id: condition.id } : condition
          ),
        };
      }
      if (group.id !== write.groupId) return group;
      return write.kind === 'add'
        ? { ...group, conditions: [...group.conditions, write.condition] }
        : { ...group, match: write.match };
    }),
  };
}

/** The same write reaches an `if`'s own conditions, which the reader edits inline. */
function writeConditionsEverywhere(state: BuilderState, write: ConditionWrite): BuilderState {
  return {
    ...state,
    conditions: writeConditions(state.conditions, write),
    actions: {
      actions: state.actions.actions.map((action) =>
        action.type === 'if'
          ? { ...action, conditions: writeConditions(action.conditions, write) }
          : action
      ),
    },
    dirty: true,
  };
}

function addAction(state: BuilderState, actionType: ActionType, branch?: BranchTarget): Action[] {
  const action = newAction(actionType);
  if (!branch) return [...state.actions.actions, action];
  // A branch holds effects only; the picker inside one never offers `if`.
  if (action.type === 'if') return state.actions.actions;

  return state.actions.actions.map((node) => {
    if (node.id !== branch.ifId || node.type !== 'if') return node;
    return branch.side === 'then'
      ? { ...node, then: [...node.then, action] }
      : { ...node, else: [...node.else, action] };
  });
}

/** A row moves within the list it sits in; null when it is already at that end. */
function moveWithin<T extends { id?: string }>(
  nodes: readonly T[],
  id: string,
  delta: number
): T[] | null {
  const from = nodes.findIndex((node) => node.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= nodes.length) return null;
  const moved = [...nodes];
  const [node] = moved.splice(from, 1);
  if (node) moved.splice(to, 0, node);
  return moved;
}

function moveAction(
  actions: AutomationActions,
  id: string,
  delta: number
): AutomationActions | null {
  const top = moveWithin(actions.actions, id, delta);
  if (top) return { actions: top };

  let moved = false;
  const next = actions.actions.map((action) => {
    if (action.type !== 'if') return action;
    const then = moveWithin(action.then, id, delta);
    const otherwise = moveWithin(action.else, id, delta);
    if (!then && !otherwise) return action;
    moved = true;
    return { ...action, then: then ?? action.then, else: otherwise ?? action.else };
  });
  return moved ? { actions: next } : null;
}

/** Which `if` holds a node, so a collapsed one can be opened before it is focused. */
export function branchOf(actions: AutomationActions, nodeId: string): string | null {
  for (const action of actions.actions) {
    if (action.type !== 'if') continue;
    const holds =
      action.then.some((leaf) => leaf.id === nodeId) ||
      action.else.some((leaf) => leaf.id === nodeId) ||
      action.conditions.groups.some(
        (group) =>
          group.id === nodeId || group.conditions.some((condition) => condition.id === nodeId)
      );
    if (holds) return idOf(action);
  }
  return null;
}

/** The row hands back the whole node, so it carries its own id and enabled flag. */
function setAction(actions: AutomationActions, id: string, next: Action): AutomationActions {
  const setLeaf = (leaves: LeafAction[]): LeafAction[] =>
    next.type === 'if' ? leaves : leaves.map((leaf) => (leaf.id === id ? next : leaf));

  return {
    actions: actions.actions.map((action) => {
      if (action.id === id) return next;
      if (action.type !== 'if') return action;
      return { ...action, then: setLeaf(action.then), else: setLeaf(action.else) };
    }),
  };
}

type NodeEdit = 'toggle' | 'remove';

/** A node left without `enabled` counts as on, so toggling one writes `false` first. */
function editNodes<T extends { id?: string; enabled?: boolean }>(
  nodes: readonly T[],
  id: string,
  edit: NodeEdit
): T[] {
  return nodes.flatMap((node): T[] => {
    if (node.id !== id) return [node];
    return edit === 'remove' ? [] : [{ ...node, enabled: node.enabled === false }];
  });
}

function editConditions(
  conditions: AutomationConditions,
  id: string,
  edit: NodeEdit
): AutomationConditions {
  return {
    groups: editNodes(conditions.groups, id, edit)
      .map((group) => ({ ...group, conditions: editNodes(group.conditions, id, edit) }))
      // The last condition takes its card with it; an empty group is not a definition.
      .filter((group) => group.conditions.length > 0),
  };
}

function editActions(actions: AutomationActions, id: string, edit: NodeEdit): AutomationActions {
  return {
    actions: editNodes(actions.actions, id, edit).map((action) =>
      action.type === 'if'
        ? {
            ...action,
            conditions: editConditions(action.conditions, id, edit),
            then: editNodes(action.then, id, edit),
            else: editNodes(action.else, id, edit),
          }
        : action
    ),
  };
}

function editNode(state: BuilderState, id: string, edit: NodeEdit): BuilderState {
  return {
    ...state,
    triggers: editNodes(state.triggers, id, edit),
    conditions: editConditions(state.conditions, id, edit),
    actions: editActions(state.actions, id, edit),
    dirty: true,
  };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.value, dirty: true };
    case 'setDescription':
      return { ...state, description: action.value, dirty: true };
    case 'setKind':
      return { ...state, kind: action.value, dirty: true };
    case 'setSeverity':
      return { ...state, severity: action.value, dirty: true };
    case 'setActive':
      return { ...state, isActive: action.value, dirty: true };
    case 'setScope':
      return { ...state, scope: action.value, dirty: true };
    case 'setEnforceAcrossServers':
      return { ...state, enforceAcrossServers: action.value, dirty: true };
    case 'addTrigger':
      return {
        ...state,
        triggers: [...state.triggers, newTrigger(action.triggerType)],
        dirty: true,
      };
    case 'setTriggerParam':
      return {
        ...state,
        triggers: state.triggers.map((trigger) =>
          trigger.id === action.id ? withParams(trigger, action.patch) : trigger
        ),
        dirty: true,
      };
    case 'addConditionGroup': {
      const group = newGroup(state.triggers);
      if (action.ifId === undefined) {
        return {
          ...state,
          conditions: { groups: [...state.conditions.groups, group] },
          dirty: true,
        };
      }
      return {
        ...state,
        actions: {
          actions: state.actions.actions.map((node) =>
            node.id === action.ifId && node.type === 'if'
              ? { ...node, conditions: { groups: [...node.conditions.groups, group] } }
              : node
          ),
        },
        dirty: true,
      };
    }
    case 'addCondition':
      return writeConditionsEverywhere(state, {
        kind: 'add',
        groupId: action.groupId,
        condition: newCondition(state.triggers),
      });
    case 'setConditionMatch':
      return writeConditionsEverywhere(state, {
        kind: 'match',
        groupId: action.groupId,
        match: action.match,
      });
    case 'setCondition':
      return writeConditionsEverywhere(state, {
        kind: 'set',
        id: action.id,
        condition: action.condition,
      });
    case 'addAction':
      return {
        ...state,
        actions: { actions: addAction(state, action.actionType, action.branch) },
        dirty: true,
      };
    case 'setAction':
      return { ...state, actions: setAction(state.actions, action.id, action.action), dirty: true };
    case 'moveAction': {
      // A row already at the end of its list has not changed, so nothing is dirty.
      const moved = moveAction(state.actions, action.id, action.delta);
      return moved ? { ...state, actions: moved, dirty: true } : state;
    }
    case 'toggleNode':
      return editNode(state, action.id, 'toggle');
    case 'removeNode':
      return editNode(state, action.id, 'remove');
    case 'load':
      return builderStateFrom(action.automation);
    case 'saved':
      return { ...state, dirty: false };
  }
}
