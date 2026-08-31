/**
 * Pure filter-composition logic for the Users page, shared by the roster query
 * and by the "select all matching" payload of the bulk trust reset. Both read
 * the same function, so the bulk action can never reach past the rows the table
 * was showing: a filter added here narrows the list and the reset together.
 */

import type { DateRangeValue, FilterState } from '@/components/ui/filters';

export type UsersFilterState = FilterState & {
  search?: string;
  hasAccessTo?: string[];
  joined?: DateRangeValue;
  active?: DateRangeValue;
  showRemoved?: true;
};

export const USERS_FILTER_DEFAULTS: UsersFilterState = {};

export interface UsersRosterParams {
  serverIds: string[] | undefined;
  hasAccessTo: string[] | undefined;
  includeRemoved: boolean;
  search: string | undefined;
  joinedAfter: string | undefined;
  joinedBefore: string | undefined;
  activeAfter: string | undefined;
  activeBefore: string | undefined;
}

/**
 * The two server inputs answer different questions and must not be merged.
 *
 * `scopedServerIds` is the global selector: which servers' data is on screen.
 * `hasAccessTo` is a property of the person: which servers they can actually
 * reach. Keeping them separate is what lets "who on this server also has the
 * 4K one" work, which collapsing either into the other would make unanswerable.
 */
export function buildUsersRosterParams(
  filters: UsersFilterState,
  scopedServerIds: string[]
): UsersRosterParams {
  return {
    serverIds: scopedServerIds.length > 0 ? scopedServerIds : undefined,
    hasAccessTo: filters.hasAccessTo?.length ? filters.hasAccessTo : undefined,
    includeRemoved: filters.showRemoved === true,
    search: filters.search,
    joinedAfter: filters.joined?.from,
    joinedBefore: filters.joined?.to,
    activeAfter: filters.active?.from,
    activeBefore: filters.active?.to,
  };
}
