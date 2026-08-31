/**
 * Pure filter-composition logic for the Violations page, shared by the list
 * query and by the "select all matching" payload of the bulk acknowledge and
 * bulk dismiss actions. Both read the same function, so a bulk dismiss can
 * never reach past the rows the table was showing: a filter added here narrows
 * the list and the dismissal together.
 */

import type { ViolationSeverity } from '@tracearr/shared';
import type { DateRangeValue, FilterState } from '@/components/ui/filters';

export type ViolationStatusFilter = 'pending' | 'acknowledged';

export type ViolationsFilterState = FilterState & {
  severity?: ViolationSeverity;
  status?: ViolationStatusFilter;
  /** Identity ids (users.id), not server account ids: one entry matches every
   *  account that person holds on servers the caller can reach. */
  people?: string[];
  rule?: string;
  occurred?: DateRangeValue;
};

export const VIOLATIONS_FILTER_DEFAULTS: ViolationsFilterState = {};

export interface ViolationsFilterParams {
  serverIds: string[] | undefined;
  severity: ViolationSeverity | undefined;
  acknowledged: boolean | undefined;
  userIds: string[] | undefined;
  ruleId: string | undefined;
  startDate: string | undefined;
  endDate: string | undefined;
}

/**
 * `scopedServerIds` is the global server selector, which decides whose data is
 * on screen. It is not a page filter and never appears in the URL state.
 */
export function buildViolationFilterParams(
  filters: ViolationsFilterState,
  scopedServerIds: string[]
): ViolationsFilterParams {
  return {
    serverIds: scopedServerIds.length > 0 ? scopedServerIds : undefined,
    severity: filters.severity,
    acknowledged: filters.status === undefined ? undefined : filters.status === 'acknowledged',
    userIds: filters.people?.length ? filters.people : undefined,
    ruleId: filters.rule,
    startDate: filters.occurred?.from,
    endDate: filters.occurred?.to,
  };
}
