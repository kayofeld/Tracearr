/**
 * Pure helpers for the Users page bulk merge action.
 */

interface MergeSelectableRow {
  userId: string;
}

export type MergeDisableReasonKey =
  | 'pages:users.mergeSelectAllActive'
  | 'pages:users.mergeSelectTwo'
  | 'pages:users.mergeSameIdentity';

export interface MergeActionState {
  disabled: boolean;
  reasonKey?: MergeDisableReasonKey;
}

/**
 * `selectedRows` carries every picked row, including ones from pages that are no
 * longer loaded, so its length is the selection count.
 */
export function deriveMergeActionState(
  selectedRows: MergeSelectableRow[],
  selectAllMode: boolean
): MergeActionState {
  if (selectAllMode) {
    return { disabled: true, reasonKey: 'pages:users.mergeSelectAllActive' };
  }
  if (selectedRows.length !== 2) {
    return { disabled: true, reasonKey: 'pages:users.mergeSelectTwo' };
  }
  const [first, second] = selectedRows;
  if (first?.userId === second?.userId) {
    return { disabled: true, reasonKey: 'pages:users.mergeSameIdentity' };
  }
  return { disabled: false };
}

interface ServerUserOverlapCandidate {
  serverId: string;
  serverName: string;
}

export function findOverlappingServerName(
  first: ServerUserOverlapCandidate[],
  second: ServerUserOverlapCandidate[]
): string | null {
  const overlap = first.find((su) => second.some((other) => other.serverId === su.serverId));
  return overlap?.serverName ?? null;
}
