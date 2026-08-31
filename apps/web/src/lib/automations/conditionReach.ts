/**
 * Whether the triggers a definition names can actually reach a condition: the
 * fields they supply, and the thresholds they can never carry past.
 */

import {
  TRIGGERS,
  contextSupplies,
  type AutomationConditions,
  type Condition,
  type TriggerNode,
} from '@tracearr/shared';
import { triggerLabel } from './catalog';
import { fieldDescriptor, type Translate } from './conditionFields';

/** A held_for measure and the condition field that reads the same clock. */
interface ThresholdPair {
  field: string;
  measure: 'current' | 'total';
}

type HeldForNode = Extract<TriggerNode, { type: 'session.held_for' }>;

/**
 * Mirrors PAUSE_CONDITION_FIELDS in the engine's wakes/crossings.ts. Pause only: the
 * inactivity sweep re-polls, so a larger day count is later, not unreachable.
 */
const THRESHOLD_PAIRS: ThresholdPair[] = [
  { field: 'current_pause_minutes', measure: 'current' },
  { field: 'total_pause_minutes', measure: 'total' },
];

const PAUSE_FIELDS: readonly string[] = THRESHOLD_PAIRS.map((pair) => pair.field);

/** The enabled triggers that cannot supply this field, by the name they go by. */
export function orphaningTriggers(
  t: Translate,
  triggers: readonly TriggerNode[],
  field: string
): string[] {
  const descriptor = fieldDescriptor(field);
  if (!descriptor) return [];

  const names = triggers
    .filter((trigger) => trigger.enabled)
    .filter((trigger) => !contextSupplies(TRIGGERS[trigger.type].context, descriptor.requires))
    .map((trigger) => triggerLabel(t, trigger.type));

  return [...new Set(names)];
}

/** The highest threshold the enabled triggers of this measure fire at. */
function firingThreshold(
  triggers: readonly TriggerNode[],
  pair: ThresholdPair
): number | undefined {
  const values = triggers
    .filter(
      (trigger): trigger is HeldForNode => trigger.enabled && trigger.type === 'session.held_for'
    )
    .filter((trigger) => trigger.params.measure === pair.measure)
    .map((trigger) => trigger.params.minutes);

  return values.length > 0 ? Math.max(...values) : undefined;
}

/**
 * The engine keeps rechecking a paused session every 30s while a non-pause condition
 * could still flip (wakes/crossings.ts holdsOpen), so the pause clock keeps growing
 * and any threshold is eventually reached.
 */
function holdsOpen(conditions: AutomationConditions): boolean {
  return conditions.groups.some((group) =>
    group.conditions.some((condition) => !PAUSE_FIELDS.includes(condition.field))
  );
}

/**
 * A pause threshold the trigger stops short of, in words. The trigger fires a second
 * past its own clock (CROSSING_PAD_MS), so the boundary itself is reachable and only
 * a strictly larger threshold is not.
 */
export function unreachableNote(
  t: Translate,
  triggers: readonly TriggerNode[],
  condition: Pick<Condition, 'field' | 'operator' | 'value'>,
  conditions: AutomationConditions
): string | null {
  if (typeof condition.value !== 'number') return null;
  if (condition.operator !== 'gt' && condition.operator !== 'gte') return null;

  const pair = THRESHOLD_PAIRS.find((entry) => entry.field === condition.field);
  if (!pair) return null;

  const threshold = firingThreshold(triggers, pair);
  if (threshold === undefined || condition.value <= threshold) return null;
  if (holdsOpen(conditions)) return null;

  return t('automations.builder.conditions.canNeverPass', {
    threshold: t('automations.describe.duration.minutes', { count: threshold }),
  });
}
