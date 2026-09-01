/**
 * The one definition of "which runs are violations".
 *
 * `/violations`, the public v1 endpoints and every rollup that counts violations
 * read `automation_runs`, which also holds notification runs and runs that
 * stopped on a condition or errored. All of them compose this fragment.
 */

import { eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { automationRuns } from '../../db/schema.js';

interface ViolationAliasOptions {
  /** Spells out the third condition of the alias definition, even where a join implies it. */
  requireUser?: boolean;
}

export function violationAliasConditions(options: ViolationAliasOptions = {}): SQL[] {
  const conditions: SQL[] = [
    eq(automationRuns.kind, 'policy'),
    eq(automationRuns.outcome, 'completed'),
  ];
  if (options.requireUser) {
    conditions.push(isNotNull(automationRuns.serverUserId));
  }
  return conditions;
}

/** The same filter for raw SQL, where automation_runs is aliased `v`. */
export const VIOLATION_ALIAS_SQL = sql`v.kind = 'policy' AND v.outcome = 'completed'`;
