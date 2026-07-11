import { describe, it, expect } from 'vitest';
import { getUserDetailScope, applyUserDetailScope } from './userDetailScope';

describe('getUserDetailScope', () => {
  it('defaults to identity scope, anchored on the URL id, when no scope param is present', () => {
    expect(getUserDetailScope('su-1', null)).toEqual({
      effectiveId: 'su-1',
      identityScope: 'identity',
      isSpecificServerScope: false,
      isAllScope: true,
    });
  });

  it('treats scope=all the same as no scope param', () => {
    expect(getUserDetailScope('su-1', 'all')).toEqual({
      effectiveId: 'su-1',
      identityScope: 'identity',
      isSpecificServerScope: false,
      isAllScope: true,
    });
  });

  it('anchors on the picked sibling account id and drops identity scope for a specific server', () => {
    expect(getUserDetailScope('su-1', 'su-2')).toEqual({
      effectiveId: 'su-2',
      identityScope: undefined,
      isSpecificServerScope: true,
      isAllScope: false,
    });
  });
});

describe('applyUserDetailScope', () => {
  it('removes the scope param when switching back to all servers', () => {
    const current = new URLSearchParams('scope=su-2&page=3');
    const next = applyUserDetailScope(current, 'all');
    expect(next.get('scope')).toBeNull();
    expect(next.get('page')).toBe('3');
  });

  it('sets the scope param to the picked account id, preserving other params', () => {
    const current = new URLSearchParams('page=3');
    const next = applyUserDetailScope(current, 'su-2');
    expect(next.get('scope')).toBe('su-2');
    expect(next.get('page')).toBe('3');
  });
});
