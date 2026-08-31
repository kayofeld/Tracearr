import {
  CONDITION_FIELDS,
  CONDITION_FIELD_LABELS,
  OPERATOR_LABELS,
  contextSupplies,
} from '@tracearr/shared';
import { automationsLogger as logger } from '../../utils/logger.js';
import { evaluatorRegistry } from './evaluators/index.js';
import type {
  AutomationConditions,
  Condition,
  ConditionEvidence,
  ConditionFieldDescriptor,
  ConditionGroup,
  EngineAutomation,
  GroupEvidence,
  TriggerContext,
} from '@tracearr/shared';
import type {
  EvaluationContext,
  EvaluationResult,
  EvaluatorResult,
  SessionEvaluationContext,
} from './types.js';

/**
 * Convert an evaluator result to condition evidence.
 */
function toConditionEvidence(condition: Condition, result: EvaluatorResult): ConditionEvidence {
  const evidence: ConditionEvidence = {
    field: condition.field,
    operator: condition.operator,
    threshold: condition.value,
    actual: result.actual,
    matched: result.matched,
  };
  if (result.relatedSessionIds?.length) {
    evidence.relatedSessionIds = result.relatedSessionIds;
  }
  if (result.details && Object.keys(result.details).length > 0) {
    evidence.details = result.details;
  }
  return evidence;
}

const UNIT_WORDS: Record<NonNullable<ConditionFieldDescriptor['unit']>, string> = {
  km: 'km',
  kmh: 'km/h',
  mbps: 'Mbps',
  days: 'days',
  minutes: 'minutes',
  hours: 'hours',
  gb: 'GB',
};

/** The labels are Title Case for headings; mid-sentence only an initialism keeps its capitals. */
const asWords = (label: string): string =>
  label
    .split(' ')
    .map((word, index) => (index === 0 || /[A-Z]{2}/.test(word) ? word : word.toLowerCase()))
    .join(' ');

/** What a condition that did not hold reads as; the negative operators invert. */
const FAILED_PHRASES: Record<string, (value: string) => string> = {
  eq: (value) => `was not ${value}`,
  neq: (value) => `was ${value}`,
  gt: (value) => `was not above ${value}`,
  gte: (value) => `was not ${value} or more`,
  lt: (value) => `was not below ${value}`,
  lte: (value) => `was not ${value} or less`,
  in: (value) => `was not one of ${value}`,
  not_in: (value) => `was one of ${value}`,
  contains: (value) => `did not contain ${value}`,
  not_contains: (value) => `contained ${value}`,
};

function thresholdWords(cond: ConditionEvidence): string {
  const value = Array.isArray(cond.threshold)
    ? cond.threshold.map((item) => String(item)).join(', ')
    : String(cond.threshold);
  const unit = CONDITION_FIELDS[cond.field]?.unit;
  return unit ? `${value} ${UNIT_WORDS[unit]}` : value;
}

const describeCondition = (cond: ConditionEvidence): string => {
  const label = asWords(CONDITION_FIELD_LABELS[cond.field] ?? cond.field);
  const phrase = FAILED_PHRASES[cond.operator];
  const value = thresholdWords(cond);
  return phrase
    ? `${label} ${phrase(value)}`
    : `${label} ${OPERATOR_LABELS[cond.operator] ?? cond.operator} ${value}`;
};

/** An all-of group stops on the conditions that failed; an any-of group failed every one of them. */
export function stoppedSummary(stoppedBy: GroupEvidence | undefined): string {
  if (!stoppedBy || stoppedBy.conditions.length === 0) return 'Nothing was checked.';
  const failed =
    stoppedBy.match === 'all'
      ? stoppedBy.conditions.filter((cond) => !cond.matched)
      : stoppedBy.conditions;
  return `${failed.map(describeCondition).join(' and ')}.`;
}

interface GroupResult {
  matched: boolean;
  conditions: ConditionEvidence[];
}

export interface AllGroupsResult {
  /** null when a group ended the walk. */
  matchedGroups: number[] | null;
  evidence: GroupEvidence[];
}

/** The narrowest trigger context this evaluation could have come from. */
function contextOf(context: EvaluationContext): TriggerContext {
  if (context.session) return 'session';
  if (context.serverUser) return 'account';
  if (context.media) return 'media';
  if (context.server) return 'server';
  return 'install';
}

function unmatchedEvidence(condition: Condition): ConditionEvidence {
  return {
    field: condition.field,
    operator: condition.operator,
    threshold: condition.value,
    actual: null,
    matched: false,
  };
}

/**
 * Evaluate a single condition and return evidence. Awaits the evaluator's
 * result whether it resolves synchronously or via a Promise.
 */
async function evaluateConditionAsync(
  context: EvaluationContext,
  condition: Condition
): Promise<ConditionEvidence> {
  const descriptor = CONDITION_FIELDS[condition.field];
  const evaluator = evaluatorRegistry[condition.field];

  if (!descriptor || !evaluator) {
    logger.warn(`No evaluator found for condition field: ${condition.field}`, {
      field: condition.field,
    });
    return unmatchedEvidence(condition);
  }

  // Defensive: the definition schema rejects a field the enabled triggers cannot supply.
  if (!contextSupplies(contextOf(context), descriptor.requires)) {
    return unmatchedEvidence(condition);
  }

  try {
    const result = evaluator(context as SessionEvaluationContext, condition);
    // Handle both sync and async evaluators
    const resolved = result instanceof Promise ? await result : result;
    return toConditionEvidence(condition, resolved);
  } catch (error) {
    logger.error(`Error evaluating condition field ${condition.field}`, {
      field: condition.field,
      error,
    });
    return unmatchedEvidence(condition);
  }
}

/**
 * Evaluate a condition group. A disabled condition is absent, so a group with
 * nothing enabled left passes; `match` names the logic and defaults to 'any'.
 * Evaluates ALL conditions in parallel to collect full evidence.
 */
async function evaluateConditionGroupAsync(
  context: EvaluationContext,
  group: ConditionGroup
): Promise<GroupResult> {
  const enabled = group.conditions.filter((condition) => condition.enabled !== false);
  if (enabled.length === 0) {
    return { matched: true, conditions: [] };
  }

  // Evaluate all conditions in parallel, collecting full evidence
  const conditions = await Promise.all(
    enabled.map((condition) => evaluateConditionAsync(context, condition))
  );

  const matched =
    group.match === 'all' ? conditions.every((c) => c.matched) : conditions.some((c) => c.matched);
  return { matched, conditions };
}

/**
 * Evaluate all condition groups (groups are AND'd together). Serves the
 * automation's own conditions and an `if` node's alike.
 * Returns evidence for all evaluated groups.
 */
export async function evaluateAllGroupsAsync(
  context: EvaluationContext,
  conditions: AutomationConditions
): Promise<AllGroupsResult> {
  if (conditions.groups.length === 0) {
    return { matchedGroups: [], evidence: [] };
  }

  const matchedGroups: number[] = [];
  const evidence: GroupEvidence[] = [];

  // Evaluate groups sequentially (AND logic requires early exit on failure)
  for (let i = 0; i < conditions.groups.length; i++) {
    const group = conditions.groups[i];
    if (!group || group.enabled === false) continue;

    const groupResult = await evaluateConditionGroupAsync(context, group);
    evidence.push({
      groupIndex: i,
      matched: groupResult.matched,
      match: group.match ?? 'any',
      conditions: groupResult.conditions,
    });

    if (!groupResult.matched) {
      return { matchedGroups: null, evidence };
    }
    matchedGroups.push(i);
  }

  return { matchedGroups, evidence };
}

/**
 * Evaluate a single rule against the given context.
 */
export async function evaluateRuleAsync(context: EvaluationContext): Promise<EvaluationResult> {
  const { rule } = context;

  const { matchedGroups, evidence } = await evaluateAllGroupsAsync(context, rule.conditions);
  const matched = matchedGroups !== null;
  const stoppedBy = matched ? undefined : evidence[evidence.length - 1];

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched,
    matchedGroups: matchedGroups ?? [],
    actions: matched ? (rule.actions?.actions ?? []) : [],
    evidence: matched ? evidence : undefined,
    ...(stoppedBy ? { stoppedBy } : {}),
  };
}

/** The scope filters that decide whether a rule is evaluated at all. */
export function ruleAppliesTo(
  rule: EngineAutomation,
  baseContext: Omit<EvaluationContext, 'rule'>
): boolean {
  if (!rule.isActive) return false;
  // A scope the context cannot name never matches: an account-scoped automation
  // has nothing to compare against on a server or install event.
  if (rule.serverId && rule.serverId !== baseContext.server?.id) return false;
  if (rule.serverUserId && rule.serverUserId !== baseContext.serverUser?.id) return false;
  if (rule.userId && rule.userId !== baseContext.serverUser?.userId) return false;
  return true;
}

/**
 * Evaluate multiple rules against the given session context.
 * Returns matching rules with their actions, or every evaluated rule when the
 * caller records a run per evaluation rather than per match.
 */
export async function evaluateRulesAsync(
  baseContext: Omit<EvaluationContext, 'rule'>,
  rules: EngineAutomation[],
  opts: { includeUnmatched?: boolean } = {}
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];

  for (const rule of rules) {
    if (!ruleAppliesTo(rule, baseContext)) {
      continue;
    }

    const context: EvaluationContext = {
      ...baseContext,
      rule,
    };

    const result = await evaluateRuleAsync(context);

    if (result.matched || opts.includeUnmatched) {
      results.push(result);
    }
  }

  return results;
}
