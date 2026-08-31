import type { ConditionField, EngineAutomation, TriggerNode } from '@tracearr/shared';

/** Fires after the boundary, never on it: gt N is false at exactly N (evaluators.test.ts, "supports gt operator for strict comparison"). */
export const CROSSING_PAD_MS = 1000;
/** Today's reconciliation-poll cadence; used only while a compound pause rule is held open. */
export const HOLD_OPEN_RECHECK_MS = 30_000;

/** Conditions on these grow with the pause itself; anything else can only flip from elsewhere. */
const PAUSE_CONDITION_FIELDS: ReadonlySet<ConditionField> = new Set([
  'current_pause_minutes',
  'total_pause_minutes',
]);

type HeldForNode = Extract<TriggerNode, { type: 'session.held_for' }>;
export type PauseMeasure = HeldForNode['params']['measure'];

export interface PauseState {
  lastPausedAt: number;
  pausedDurationMs: number;
  now: number;
}

export interface PauseCrossingInput extends PauseState {
  rules: EngineAutomation[];
}

export interface PauseCrossing {
  at: number;
  /** The node whose threshold this is; null for the compound-rule recheck, which belongs to no node. */
  nodeId: string | null;
}

export interface PauseCrossingResult {
  /** Earliest crossing strictly after now to evaluate at, or null when nothing is left to wait for. */
  next: PauseCrossing | null;
  /** Earliest crossing at all, past or future; rehydrate uses it to evaluate immediately. */
  earliest: PauseCrossing | null;
  /** A satisfied held_for node shares a rule with a non-pause condition; keep rechecking. */
  holdOpen: boolean;
}

/** The one reading of pause time by measure: current is this pause, total adds what earlier pauses banked. */
export function pauseMinutes(measure: PauseMeasure, state: PauseState): number {
  const currentMs = state.now - state.lastPausedAt;
  return (measure === 'current' ? currentMs : state.pausedDurationMs + currentMs) / 60_000;
}

/** The enabled held_for nodes a wake has to wait for. */
export function heldForNodes(rule: EngineAutomation): HeldForNode[] {
  return rule.triggers.filter(
    (node): node is HeldForNode => node.enabled && node.type === 'session.held_for'
  );
}

/** The instant pauseMinutes reaches the node's threshold; the inverse of pauseMinutes. */
function crossingOf(node: HeldForNode, input: PauseCrossingInput): number {
  const thresholdMs = node.params.minutes * 60_000;
  const at =
    node.params.measure === 'current'
      ? input.lastPausedAt + thresholdMs
      : input.lastPausedAt + thresholdMs - input.pausedDurationMs;
  return at + CROSSING_PAD_MS;
}

function satisfiedNow(node: HeldForNode, input: PauseCrossingInput): boolean {
  return pauseMinutes(node.params.measure, input) >= node.params.minutes;
}

/** The trigger has already fired, so only a companion condition is left to flip; those change without a crossing. */
function holdsOpen(
  rule: EngineAutomation,
  nodes: HeldForNode[],
  input: PauseCrossingInput
): boolean {
  if (!nodes.some((node) => satisfiedNow(node, input))) return false;
  // A disabled group or condition is absent to the engine, so it cannot flip anything either.
  return rule.conditions.groups.some(
    (group) =>
      group.enabled !== false &&
      group.conditions.some((c) => c.enabled !== false && !PAUSE_CONDITION_FIELDS.has(c.field))
  );
}

export function pauseCrossings(input: PauseCrossingInput): PauseCrossingResult {
  let next: PauseCrossing | null = null;
  let earliest: PauseCrossing | null = null;
  let holdOpen = false;

  for (const rule of input.rules) {
    if (!rule.isActive) continue;
    const nodes = heldForNodes(rule);
    if (nodes.length === 0) continue;
    for (const node of nodes) {
      const at = crossingOf(node, input);
      if (earliest === null || at < earliest.at) earliest = { at, nodeId: node.id };
      if (at > input.now && (next === null || at < next.at)) next = { at, nodeId: node.id };
    }
    if (holdsOpen(rule, nodes, input)) holdOpen = true;
  }

  if (holdOpen) {
    const recheck = input.now + HOLD_OPEN_RECHECK_MS;
    if (next === null || recheck < next.at) next = { at: recheck, nodeId: null };
  }
  return { next, earliest, holdOpen };
}
