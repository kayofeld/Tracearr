import { describe, it, expect } from 'vitest';
import { buildUsersRosterParams, USERS_FILTER_DEFAULTS } from './usersFilters';

describe('buildUsersRosterParams', () => {
  it('sends no narrowing at all for the default filters with no server selected', () => {
    expect(buildUsersRosterParams(USERS_FILTER_DEFAULTS, [])).toEqual({
      serverIds: undefined,
      hasAccessTo: undefined,
      includeRemoved: false,
      search: undefined,
      joinedAfter: undefined,
      joinedBefore: undefined,
      activeAfter: undefined,
      activeBefore: undefined,
    });
  });

  it('takes the view scope from the global server selector', () => {
    const params = buildUsersRosterParams(USERS_FILTER_DEFAULTS, ['server-1', 'server-2']);

    expect(params.serverIds).toEqual(['server-1', 'server-2']);
  });

  it('keeps the access filter separate from the view scope instead of overriding it', () => {
    const params = buildUsersRosterParams({ hasAccessTo: ['server-3'] }, ['server-1']);

    // "who on server-1 also reaches server-3" is unanswerable if either
    // collapses into the other.
    expect(params.serverIds).toEqual(['server-1']);
    expect(params.hasAccessTo).toEqual(['server-3']);
  });

  it('drops an emptied access filter rather than sending an empty list', () => {
    expect(buildUsersRosterParams({ hasAccessTo: [] }, []).hasAccessTo).toBeUndefined();
  });

  it('maps both date ranges onto their open-ended API bounds', () => {
    const params = buildUsersRosterParams(
      {
        joined: { from: '2024-01-01', to: '2024-02-01' },
        active: { to: '2024-03-15' },
      },
      []
    );

    expect(params).toMatchObject({
      joinedAfter: '2024-01-01',
      joinedBefore: '2024-02-01',
      activeAfter: undefined,
      activeBefore: '2024-03-15',
    });
  });

  it('carries the search text and the removed toggle', () => {
    const params = buildUsersRosterParams({ search: 'bob', showRemoved: true }, []);

    expect(params).toMatchObject({ search: 'bob', includeRemoved: true });
  });
});
