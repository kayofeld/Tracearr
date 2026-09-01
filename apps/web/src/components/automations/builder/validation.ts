/**
 * Every problem the page can show, addressed to the row that has to fix it. The
 * shared schema does the judging; this only translates it and finds the node.
 */

import {
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_NAME_MAX,
  createAutomationSchema,
  type Action,
  type Condition,
  type ConditionGroup,
} from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import { orphaningTriggers, type Translate } from '@/lib/automations';
import { TRIGGER_PARAM_BOUNDS, toCreateInput, type BuilderState } from './builderReducer';

/** What a problem points at when it belongs to the page rather than to a node. */
export const BUILDER_SECTIONS = {
  name: 'name',
  description: 'description',
  triggers: 'triggers',
  conditions: 'conditions',
  actions: 'actions',
  scope: 'scope',
  kind: 'kind',
} as const;

export interface BuilderIssue {
  nodeId: string;
  message: string;
  /** An amber note about what the rest of the definition did, not about this field's own value. */
  tone?: 'warning';
}

export type NodeIssues = Map<string, BuilderIssue[]>;

/** `path` starts at the `groups` key, whether the groups are the page's or an `if`'s. */
function groupsNodeId(
  groups: readonly ConditionGroup[],
  path: readonly PropertyKey[]
): string | undefined {
  const groupIndex = path[1];
  if (typeof groupIndex !== 'number') return undefined;
  const group = groups[groupIndex];
  if (!group) return undefined;

  const conditionIndex = path[3];
  if (path[2] !== 'conditions' || typeof conditionIndex !== 'number') return group.id;
  return group.conditions[conditionIndex]?.id ?? group.id;
}

/** `path` starts at the `actions` key of the actions container. */
function actionsNodeId(
  actions: readonly Action[],
  path: readonly PropertyKey[]
): string | undefined {
  const actionIndex = path[1];
  if (typeof actionIndex !== 'number') return undefined;
  const action = actions[actionIndex];
  if (action?.type !== 'if') return action?.id;

  if (path[2] === 'conditions') {
    return groupsNodeId(action.conditions.groups, path.slice(3)) ?? action.id;
  }
  if (path[2] === 'then' || path[2] === 'else') {
    const leafIndex = path[3];
    if (typeof leafIndex === 'number') return action[path[2]][leafIndex]?.id ?? action.id;
  }
  return action.id;
}

function nodeIdForPath(state: BuilderState, path: readonly PropertyKey[]): string {
  const head = path[0];

  if (head === 'triggers') {
    const index = path[1];
    if (typeof index === 'number') return state.triggers[index]?.id ?? BUILDER_SECTIONS.triggers;
    return BUILDER_SECTIONS.triggers;
  }
  if (head === 'conditions') {
    return groupsNodeId(state.conditions.groups, path.slice(1)) ?? BUILDER_SECTIONS.conditions;
  }
  if (head === 'actions') {
    return actionsNodeId(state.actions.actions, path.slice(1)) ?? BUILDER_SECTIONS.actions;
  }
  if (head === 'serverId' || head === 'serverUserId' || head === 'userId') {
    return BUILDER_SECTIONS.scope;
  }
  if (head === 'description') return BUILDER_SECTIONS.description;
  return BUILDER_SECTIONS.name;
}

/** Every condition on the page, wherever it sits, so a message can name its field. */
function conditionById(state: BuilderState, nodeId: string): Condition | undefined {
  const groups = [
    ...state.conditions.groups,
    ...state.actions.actions.flatMap((action) =>
      action.type === 'if' ? action.conditions.groups : []
    ),
  ];
  return groups.flatMap((group) => group.conditions).find((condition) => condition.id === nodeId);
}

/** What an action got wrong; a condition inside an `if` reads as a condition, not as an action. */
function actionMessage(t: Translate, key: PropertyKey): string | undefined {
  switch (key) {
    case 'to':
      return t('automations.builder.errors.sendNeedsDestination');
    case 'amount':
      return t('automations.builder.errors.trustAmountRange');
    case 'value':
      return t('automations.builder.errors.trustValueRange');
    case 'message':
      return t('automations.builder.errors.messageRequired');
    default:
      return undefined;
  }
}

/** A field the triggers cannot supply is best named by the trigger that cannot supply it. */
function unavailableField(t: Translate, state: BuilderState, nodeId: string): string {
  const field = conditionById(state, nodeId)?.field;
  const triggers = field === undefined ? [] : orphaningTriggers(t, state.triggers, field);
  if (triggers.length === 0) return t('automations.builder.errors.fieldUnavailable');
  return t('automations.builder.errors.fieldNotAvailableFor', { triggers: triggers.join(', ') });
}

/** What the schema or the API rejected, before it is turned into words. */
interface RawIssue {
  path: readonly PropertyKey[];
  message: string;
  /** The zod code, so a length complaint reads differently from a missing value. */
  code?: string;
}

/** The path's last key says what went wrong; the schema's English is the last resort. */
function messageFor(t: Translate, issue: RawIssue, state: BuilderState, nodeId: string): string {
  const { path, message: fallback } = issue;
  const last = path[path.length - 1] ?? '';
  if (path[0] === 'actions' && !path.includes('conditions')) {
    const message = actionMessage(t, last);
    if (message !== undefined) return message;
  }

  switch (last) {
    case 'field':
      return unavailableField(t, state, nodeId);
    case 'operator':
      return t('automations.builder.errors.operatorInvalid');
    case 'value':
      return t('automations.builder.errors.valueInvalid');
    case 'type':
      return t('automations.builder.errors.actionUnavailable');
    case 'title':
    case 'body':
      return t('automations.builder.errors.variableUnavailable');
    case 'minutes':
      return t('automations.builder.errors.minutesRange', { ...TRIGGER_PARAM_BOUNDS.minutes });
    case 'days':
      return t('automations.builder.errors.daysRange', { ...TRIGGER_PARAM_BOUNDS.days });
    case 'measure':
      return t('automations.builder.errors.measureInvalid');
    case 'name':
      return issue.code === 'too_big'
        ? t('automations.builder.errors.tooLong', { max: AUTOMATION_NAME_MAX })
        : t('automations.builder.errors.nameRequired');
    case 'description':
      return issue.code === 'too_big'
        ? t('automations.builder.errors.tooLong', { max: AUTOMATION_DESCRIPTION_MAX })
        : fallback;
    case 'serverId':
    case 'serverUserId':
    case 'userId':
      return t('automations.builder.errors.scopeIncomplete');
    // Both trigger refinements land on the same path, and only one can hold at a time:
    // the policy check needs an enabled trigger to have anything to object to.
    case 'triggers':
      return state.triggers.some((trigger) => trigger.enabled)
        ? t('automations.builder.errors.policyNeedsSubject')
        : t('automations.builder.errors.triggerRequired');
    default:
      return fallback;
  }
}

/** Availability is a consequence of the triggers, so it reads amber and shows untouched. */
function toneFor(path: readonly PropertyKey[]): Pick<BuilderIssue, 'tone'> {
  return path[path.length - 1] === 'field' ? { tone: 'warning' } : {};
}

export function builderIssues(state: BuilderState, t: Translate): BuilderIssue[] {
  const issues: BuilderIssue[] = [];

  const parsed = createAutomationSchema.safeParse(toCreateInput(state));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const nodeId = nodeIdForPath(state, issue.path);
      const message = messageFor(t, issue, state, nodeId);
      issues.push({ nodeId, message, ...toneFor(issue.path) });
    }
  }

  return issues;
}

interface ServerField {
  field: string;
  message: string;
}

function isServerField(value: unknown): value is ServerField {
  if (typeof value !== 'object' || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return typeof record.field === 'string' && typeof record.message === 'string';
}

/** The API names a rejected field as `body.conditions.groups.0.conditions.1.field`. */
function pathFromField(field: string): PropertyKey[] {
  const parts = field.split('.');
  const start = parts[0] === 'body' ? 1 : 0;
  return parts.slice(start).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** What the API rejected, pointed at the same rows the local check uses. */
export function serverIssues(state: BuilderState, error: unknown, t: Translate): BuilderIssue[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.body.details;
  if (typeof details !== 'object' || details === null) return [];
  const record: Record<string, unknown> = { ...details };
  if (!Array.isArray(record.fields)) return [];

  return record.fields.filter(isServerField).map((entry) => {
    const path = pathFromField(entry.field);
    const nodeId = nodeIdForPath(state, path);
    const message = messageFor(t, { path, message: entry.message }, state, nodeId);
    return { nodeId, message, ...toneFor(path) };
  });
}

export function issuesByNode(issues: readonly BuilderIssue[]): NodeIssues {
  const byNode: NodeIssues = new Map();
  for (const issue of issues) {
    const held = byNode.get(issue.nodeId);
    if (held) held.push(issue);
    else byNode.set(issue.nodeId, [issue]);
  }
  return byNode;
}
