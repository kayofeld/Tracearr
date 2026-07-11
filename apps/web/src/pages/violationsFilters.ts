/**
 * Pure filter-composition logic for the Violations page, shared by the list
 * query and the bulk acknowledge/dismiss "select all matching" filters.
 * Keeping this in one function means the two can never drift apart - if
 * select-all only ever sends what this function returns, it can never touch
 * more violations than what the list itself is currently showing.
 */

import type { ViolationSeverity } from '@tracearr/shared';

export interface ViolationFilterState {
  severityFilter: ViolationSeverity | 'all';
  acknowledgedFilter: 'all' | 'pending' | 'acknowledged';
  // Identity ids (users.id) selected in the people multiselect. Empty means
  // no person filter is active.
  personFilter: string[];
  selectedServerIds: string[];
}

export interface ViolationFilterParams {
  serverIds: string[] | undefined;
  severity: ViolationSeverity | undefined;
  acknowledged: boolean | undefined;
  userIds: string[] | undefined;
}

export function buildViolationFilterParams(state: ViolationFilterState): ViolationFilterParams {
  return {
    serverIds: state.selectedServerIds.length > 0 ? state.selectedServerIds : undefined,
    severity: state.severityFilter === 'all' ? undefined : state.severityFilter,
    acknowledged:
      state.acknowledgedFilter === 'all' ? undefined : state.acknowledgedFilter === 'acknowledged',
    userIds: state.personFilter.length > 0 ? state.personFilter : undefined,
  };
}
