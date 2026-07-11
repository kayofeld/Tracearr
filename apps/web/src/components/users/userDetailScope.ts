/**
 * Pure helper deriving the UserDetail page's account scope from the URL.
 *
 * The route stays on the representative account (/users/:id); the ?scope=
 * query param narrows the view to one specific sibling account. Absent or
 * scope=all shows the whole person's combined data across every account
 * the caller can access.
 */

export interface UserDetailScope {
  /** The account id every data-fetching hook should anchor on. */
  effectiveId: string | undefined;
  /** Query param value to send to identity-aware endpoints. */
  identityScope: 'identity' | undefined;
  /** True when narrowed to one specific sibling account. */
  isSpecificServerScope: boolean;
  /** True when showing the whole person's combined data. */
  isAllScope: boolean;
}

export function getUserDetailScope(
  id: string | undefined,
  scopeParam: string | null
): UserDetailScope {
  const isSpecificServerScope = scopeParam != null && scopeParam !== 'all';
  return {
    effectiveId: isSpecificServerScope ? scopeParam : id,
    identityScope: isSpecificServerScope ? undefined : 'identity',
    isSpecificServerScope,
    isAllScope: !isSpecificServerScope,
  };
}

/**
 * Build the next URLSearchParams for a scope picker change, preserving
 * every other existing query param.
 */
export function applyUserDetailScope(current: URLSearchParams, value: string): URLSearchParams {
  const next = new URLSearchParams(current);
  if (value === 'all') {
    next.delete('scope');
  } else {
    next.set('scope', value);
  }
  return next;
}
