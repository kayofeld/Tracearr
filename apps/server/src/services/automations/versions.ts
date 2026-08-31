import { sql } from 'drizzle-orm';
import { canonicalJson } from '@tracearr/shared';
import type {
  AutomationKind,
  AutomationActions,
  AutomationConditions,
  TriggerNode,
  ViolationSeverity,
} from '@tracearr/shared';
import type { Executor } from '../../db/client.js';
import { automationVersions, type automations } from '../../db/schema.js';

export type AutomationRow = typeof automations.$inferSelect;

/** The column has no null state; a notification automation keeps the default it ignores. */
export const storedSeverity = (severity: ViolationSeverity | null | undefined): ViolationSeverity =>
  severity ?? 'warning';

/**
 * The snapshot an automation_versions row stores; scope and definition, no runtime
 * settings. Inferred rather than declared so it stays assignable to the jsonb column.
 */
export type AutomationDefinition = ReturnType<typeof automationDefinition>;

export function automationDefinition(row: {
  name: string;
  kind: AutomationKind;
  severity: ViolationSeverity | null;
  triggers: TriggerNode[] | null;
  conditions: AutomationConditions | null;
  actions: AutomationActions | null;
  serverId: string | null;
  serverUserId: string | null;
  userId: string | null;
  enforceAcrossServers: boolean;
}) {
  return {
    name: row.name,
    kind: row.kind,
    severity: row.severity,
    triggers: row.triggers ?? [],
    conditions: row.conditions,
    actions: row.actions ?? { actions: [] },
    serverId: row.serverId,
    serverUserId: row.serverUserId,
    userId: row.userId,
    enforceAcrossServers: row.enforceAcrossServers,
  };
}

/**
 * A zod parse keeps the payload's key order and jsonb hands its own back, so
 * comparing the two by serialization reports a difference on every save unless
 * the order is normalized away first.
 */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Two definitions differ when the stored snapshot would, which is what makes a write version-worthy. */
export function sameDefinition(a: AutomationDefinition, b: AutomationDefinition): boolean {
  return canonicalEqual(a, b);
}

/**
 * Append the next version for an automation. The number is computed in the same
 * statement, so the write and the numbering share the caller's transaction.
 */
export async function insertAutomationVersion(
  executor: Executor,
  automationId: string,
  definition: AutomationDefinition
): Promise<string | undefined> {
  const rows = await executor
    .insert(automationVersions)
    .values({
      automationId,
      version: sql`(SELECT coalesce(max(v.version), 0) + 1 FROM automation_versions v WHERE v.automation_id = ${automationId})`,
      definition,
    })
    .returning({ id: automationVersions.id });
  return rows[0]?.id;
}
