import { z } from 'zod';
import { listDateBoundSchema, listSortSchema } from '../listQuery.js';
import {
  booleanStringSchema,
  crossServerEnforcementRefinement,
  hasAtMostOneScope,
  paginationSchema,
  scopeAllowsCrossServerEnforcement,
  scopeRefinement,
  uuidSchema,
  violationSeveritySchema,
} from '../schemas.js';
import { ACTIONS, automationActionsSchema } from './actions.js';
import { CONDITION_FIELDS, automationConditionsSchema } from './conditions.js';
import {
  NOTIFICATION_ONLY_TRIGGERS,
  TRIGGERS,
  TRIGGER_GROUPS,
  contextOf,
  contextSupplies,
  triggerNodeSchema,
  variablesFor,
} from './triggers.js';
import type { Action, AutomationActions } from './actions.js';
import type {
  AutomationConditions,
  ConditionField,
  ConditionFieldDescriptor,
  ConditionGroup,
  ConditionValue,
  Operator,
} from './conditions.js';
import type { TriggerNode } from './triggers.js';
import type { MediaType, ViolationSeverity } from '../types.js';

export const AUTOMATION_KINDS = ['policy', 'notification'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

// 'error' belongs to a run that failed before its terminal write; a bookkeeping failure
// after that write notes itself in steps rather than demoting the row.
export const RUN_OUTCOMES = ['completed', 'stopped_by_condition', 'error'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Days a completed run survives when its automation names no retention of its own. */
export const RETENTION_DEFAULTS = {
  policy: 365,
  notification: 30,
} as const satisfies Record<AutomationKind, number>;

/** The automations column, and what a name has to fit into. */
export const AUTOMATION_NAME_MAX = 100;

/** The note beside the name, capped the same way the column is. */
export const AUTOMATION_DESCRIPTION_MAX = 500;

const automationFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(AUTOMATION_NAME_MAX),
  description: z.string().max(AUTOMATION_DESCRIPTION_MAX).nullable().optional(),
  kind: z.enum(AUTOMATION_KINDS),
  severity: violationSeveritySchema.nullable(),
  triggers: z.array(triggerNodeSchema),
  conditions: automationConditionsSchema,
  actions: automationActionsSchema,
  serverId: uuidSchema.nullable().optional(),
  serverUserId: uuidSchema.nullable().optional(),
  userId: uuidSchema.nullable().optional(),
  enforceAcrossServers: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(0).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  isActive: z.boolean().optional(),
});

const VAR_RE = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function valueMatches(
  descriptor: ConditionFieldDescriptor,
  operator: Operator,
  value: ConditionValue
): boolean {
  if (operator === 'in' || operator === 'not_in') return Array.isArray(value);
  switch (descriptor.valueType) {
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    // `in`/`not_in` returned above; what is left on a list field is one of its options.
    case 'multiSelect':
      return typeof value === 'string';
    default:
      return typeof value === 'string';
  }
}

/**
 * Everything a definition has to satisfy beyond the node schemas: what the triggers
 * can supply is what the conditions, actions and message variables may name.
 */
function definitionRefinements(
  def: {
    kind: AutomationKind;
    triggers: TriggerNode[];
    conditions: AutomationConditions;
    actions: AutomationActions;
  },
  ctx: z.RefinementCtx
): void {
  const { triggers } = def;
  const enabled = triggers.filter((trigger) => trigger.enabled);
  if (enabled.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['triggers'],
      message: 'At least one enabled trigger is required',
    });
  }
  const context = contextOf(triggers);
  if (
    def.kind === 'policy' &&
    enabled.some((trigger) => !contextSupplies(TRIGGERS[trigger.type].context, 'account'))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['triggers'],
      message: 'A policy needs a stream or account trigger: violations are about a user',
    });
  }
  // A session context supplies an account, so the rule above would let a policy sit on a new device.
  if (
    def.kind === 'policy' &&
    enabled.some((trigger) =>
      (NOTIFICATION_ONLY_TRIGGERS as readonly string[]).includes(trigger.type)
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['triggers'],
      message:
        'New device and trust score changed can only send: neither is something a person did wrong',
    });
  }
  // A trust action one hop from the writer that fired the trigger walks the score down on every run.
  const watchesTrust = enabled.some((trigger) => trigger.type === 'account.trust_changed');
  const checkGroups = (groups: ConditionGroup[], path: (string | number)[]) => {
    groups.forEach((group, groupIndex) =>
      group.conditions.forEach((condition, conditionIndex) => {
        const descriptor = CONDITION_FIELDS[condition.field];
        const at = [...path, groupIndex, 'conditions', conditionIndex];
        if (
          condition.enabled !== false &&
          context !== null &&
          !contextSupplies(context, descriptor.requires)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'field'],
            message: `${condition.field} is not available for every enabled trigger`,
          });
        }
        if (!descriptor.operators.includes(condition.operator)) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'operator'],
            message: `${condition.operator} is not valid for ${condition.field}`,
          });
        }
        if (!valueMatches(descriptor, condition.operator, condition.value)) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'value'],
            message: `value does not fit ${condition.field}`,
          });
        }
      })
    );
  };
  checkGroups(def.conditions.groups, ['conditions', 'groups']);
  const vars = new Set(variablesFor(triggers));
  const checkAction = (action: Action, path: (string | number)[]) => {
    if (action.enabled !== false) {
      const need = ACTIONS[action.type].requires;
      if (context !== null && !contextSupplies(context, need)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'type'],
          message: `${action.type} needs a ${need} trigger`,
        });
      }
      if (watchesTrust && action.type === 'trust') {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'type'],
          message: 'An automation that watches trust cannot also change it',
        });
      }
    }
    if (action.type !== 'send') return;
    for (const field of ['title', 'body'] as const) {
      for (const match of (action[field] ?? '').matchAll(VAR_RE)) {
        const name = match[1] ?? '';
        if (!vars.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, field],
            message: `{{${name}}} is not available for every enabled trigger`,
          });
        }
      }
    }
  };
  def.actions.actions.forEach((action, index) => {
    const path = ['actions', 'actions', index];
    checkAction(action, path);
    if (action.type === 'if' && action.enabled !== false) {
      checkGroups(action.conditions.groups, [...path, 'conditions', 'groups']);
      action.then.forEach((leaf, leafIndex) => checkAction(leaf, [...path, 'then', leafIndex]));
      action.else.forEach((leaf, leafIndex) => checkAction(leaf, [...path, 'else', leafIndex]));
    }
  });
}

export const automationDefinitionSchema = automationFieldsSchema.superRefine(definitionRefinements);

export const createAutomationSchema = automationDefinitionSchema
  .refine(hasAtMostOneScope, scopeRefinement)
  .refine(scopeAllowsCrossServerEnforcement, crossServerEnforcementRefinement);

export const updateAutomationSchema = automationFieldsSchema
  .partial()
  .refine(hasAtMostOneScope, scopeRefinement)
  .refine(scopeAllowsCrossServerEnforcement, crossServerEnforcementRefinement);

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

export const AUTOMATION_SORT_FIELDS = [
  'name',
  'createdAt',
  'updatedAt',
  'kind',
  'isActive',
] as const;
export type AutomationSortField = (typeof AUTOMATION_SORT_FIELDS)[number];

/** The three ways a template arrives; a row no template wrote is the fourth answer. */
const TEMPLATE_SOURCES = ['builtin', 'import', 'local'] as const;
export const AUTOMATION_SOURCES = [...TEMPLATE_SOURCES, 'own'] as const;
export type AutomationSource = (typeof AUTOMATION_SOURCES)[number];

export const automationListQuerySchema = paginationSchema
  .extend({
    kind: z.enum(AUTOMATION_KINDS).optional(),
    enabled: booleanStringSchema.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    source: z.enum(AUTOMATION_SOURCES).optional(),
    serverId: uuidSchema.optional(),
    trigger: z.enum(TRIGGER_GROUPS).optional(),
    severity: violationSeveritySchema.optional(),
  })
  .extend(listSortSchema(AUTOMATION_SORT_FIELDS).shape);
export type AutomationListQuery = z.infer<typeof automationListQuerySchema>;

export const RUN_SORT_FIELDS = ['startedAt', 'finishedAt', 'outcome'] as const;
export type RunSortField = (typeof RUN_SORT_FIELDS)[number];

/** What a page of runs and a count of them filter on, so neither can drift. */
export const runCountsQuerySchema = z.object({
  kind: z.enum(AUTOMATION_KINDS).optional(),
  outcome: z.enum(RUN_OUTCOMES).optional(),
  automationId: uuidSchema.optional(),
  // Calendar days against the run's start, resolved to half-open UTC bounds.
  startDate: listDateBoundSchema,
  endDate: listDateBoundSchema,
});

export const runListQuerySchema = paginationSchema
  .extend(runCountsQuerySchema.shape)
  .extend(listSortSchema(RUN_SORT_FIELDS).shape);
export type RunListQuery = z.infer<typeof runListQuerySchema>;

/** How many runs each outcome holds, plus the newest run that did something. */
export type RunCounts = Record<RunOutcome, number> & {
  total: number;
  lastRunAt: string | null;
};

export const NEAR_MISS_REASONS = [
  'cooldown_active',
  'edge_replayed',
  'gate_blocked',
  'trigger_filter_failed',
] as const;
export type NearMissReason = (typeof NEAR_MISS_REASONS)[number];

/** One entry of the capped ring: a trigger matched but the pipeline recorded no run. */
export const nearMissEntrySchema = z.object({
  reason: z.enum(NEAR_MISS_REASONS),
  at: z.iso.datetime(),
  subjectKey: z.string(),
  trigger: z.string(),
});
export type NearMissEntry = z.infer<typeof nearMissEntrySchema>;

/** Every condition and action node carries these once the builder has stamped it. */
export interface NodeFields {
  id?: string;
  enabled?: boolean;
}

// Evidence types for violation diagnostics
export interface ConditionEvidence {
  field: ConditionField;
  operator: Operator;
  threshold: ConditionValue;
  actual: unknown;
  matched: boolean;
  relatedSessionIds?: string[];
  details?: Record<string, unknown>;
}

export interface GroupEvidence {
  groupIndex: number;
  matched: boolean;
  /** The group's logic, so a summary can name the failing condition rather than the whole group. */
  match?: 'all' | 'any';
  conditions: ConditionEvidence[];
}

// Action result types (for UI display of action execution results)
export interface ActionResult {
  actionType: string;
  success: boolean;
  skipped?: boolean;
  skipReason?: string;
  errorMessage?: string;
  executedAt?: string;
}

/** What an automation applies to, named for display. */
export interface AutomationScopeRef {
  kind: 'server' | 'account' | 'person';
  id: string;
  name: string;
  /** The server an account sits on; the account id alone does not say which. */
  serverId?: string;
  serverName?: string;
}

/** The template an automation is bound to, with the version it sits on. */
export interface AutomationTemplateRef {
  id: string;
  slug: string;
  name: string;
  version: number;
  currentVersion: number;
  source: (typeof TEMPLATE_SOURCES)[number];
  /** Whoever the envelope named; null for anything nobody signed. */
  author: string | null;
  /** When the template entered this library, which is when an import was pasted. */
  addedAt: string;
}

/** Where a detached automation came from; the template may be gone by now. */
export interface AutomationOrigin {
  templateId: string;
  version: number;
  name: string | null;
}

/** API shape. Dates are ISO strings; `triggers` is what the engine matches on. */
export interface Automation {
  id: string;
  name: string;
  description: string | null;
  kind: AutomationKind;
  severity: ViolationSeverity | null;
  triggers: TriggerNode[];
  conditions: AutomationConditions;
  actions: AutomationActions;
  serverId: string | null;
  serverUserId: string | null;
  userId: string | null;
  enforceAcrossServers: boolean;
  isActive: boolean;
  cooldownMinutes: number | null;
  /** null falls back to the kind's default retention */
  retentionDays: number | null;
  scopeRef: AutomationScopeRef | null;
  template: AutomationTemplateRef | null;
  /** What was answered when the row was bound; null for anything not on a template. */
  templateInputs: Record<string, unknown> | null;
  origin: AutomationOrigin | null;
  createdAt: string;
  updatedAt: string;
}

/** What a run was about, read off its subject key. */
export type RunSubjectKind = 'session' | 'account' | 'media' | 'server' | 'install';

/** The names behind a run's ids. Every field is null once the row it named is gone. */
export interface RunSubject {
  kind: RunSubjectKind;
  /** The account for session and account runs; the item's title for media runs. */
  name: string | null;
  /** The person the account belongs to, when the identity carries a name. */
  personName: string | null;
  /** The account's avatar, as the media server stores it. */
  thumbUrl: string | null;
  /** Null for install-wide runs, the only ones no server is behind. */
  serverName: string | null;
  /** The library a media subject sits in. */
  libraryName: string | null;
  /** A media subject's own type; sessions carry theirs in the session context. */
  mediaType: string | null;
}

/**
 * What was playing when a session run fired. The session row carries all of it; once
 * that row is gone only what the run stamped on itself is left, so most of it is nullable.
 */
export interface RunSessionContext {
  mediaTitle: string | null;
  mediaType: MediaType | null;
  /** The show an episode belongs to. */
  grandparentTitle: string | null;
  player: string | null;
  device: string | null;
  product: string | null;
  platform: string | null;
  ipAddress: string | null;
  city: string | null;
  country: string | null;
}

export interface AutomationRunSummary {
  id: string;
  automationId: string;
  automationName: string;
  kind: AutomationKind;
  outcome: RunOutcome;
  humanSummary: string | null;
  severity: ViolationSeverity | null;
  serverUserId: string | null;
  sessionId: string | null;
  /** Null only for a run with no server account to attribute it to. */
  serverId: string | null;
  subjectKey: string | null;
  subject: RunSubject;
  /** The actions that ran and succeeded, so a row can say what it did. */
  ranActions: string[];
  startedAt: string;
  finishedAt: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
}

/**
 * The socket payload for finished runs. Clients only refetch on it, so it names
 * which lists went stale and nothing else: the frame reaches every viewer in the
 * sessions room, and a run summary carries subject keys and stop reasons.
 */
export interface RunFinishedEvent {
  id: string;
  automationId: string;
  kind: AutomationKind;
  outcome: RunOutcome;
}

export interface AutomationRun extends AutomationRunSummary {
  /** Ordered step log; step zero is the trigger payload. */
  steps: unknown[];
  /** Null for anything but a session run, and for a session that has since been purged. */
  session: RunSessionContext | null;
  /** Every condition the run weighed, so a completed run can say what it read. */
  evidence: GroupEvidence[];
  definitionVersionId: string | null;
}
