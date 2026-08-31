import { describe, it, expect } from 'vitest';
import { buildViolationFilterParams, VIOLATIONS_FILTER_DEFAULTS } from './violationsFilters';

describe('buildViolationFilterParams', () => {
  it('sends no narrowing at all for the default filters with no server selected', () => {
    expect(buildViolationFilterParams(VIOLATIONS_FILTER_DEFAULTS, [])).toEqual({
      serverIds: undefined,
      severity: undefined,
      acknowledged: undefined,
      userIds: undefined,
      ruleId: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it('takes the view scope from the global server selector rather than from a filter', () => {
    const params = buildViolationFilterParams(VIOLATIONS_FILTER_DEFAULTS, ['server-a', 'server-b']);

    expect(params.serverIds).toEqual(['server-a', 'server-b']);
  });

  it('maps every filter through to its API param', () => {
    const params = buildViolationFilterParams(
      {
        severity: 'high',
        status: 'acknowledged',
        people: ['person-1'],
        rule: 'rule-9',
        occurred: { from: '2026-01-01', to: '2026-02-01' },
      },
      ['server-a']
    );

    expect(params).toEqual({
      serverIds: ['server-a'],
      severity: 'high',
      acknowledged: true,
      userIds: ['person-1'],
      ruleId: 'rule-9',
      startDate: '2026-01-01',
      endDate: '2026-02-01',
    });
  });

  it('maps a pending status filter to acknowledged: false, which is not the same as absent', () => {
    expect(buildViolationFilterParams({ status: 'pending' }, []).acknowledged).toBe(false);
  });

  it('carries an open-ended date bound on its own', () => {
    expect(buildViolationFilterParams({ occurred: { to: '2026-03-15' } }, [])).toMatchObject({
      startDate: undefined,
      endDate: '2026-03-15',
    });
  });

  it('carries several selected people as a single userIds array', () => {
    const params = buildViolationFilterParams({ people: ['person-1', 'person-2', 'person-3'] }, []);

    expect(params.userIds).toEqual(['person-1', 'person-2', 'person-3']);
  });

  it('drops an emptied people filter rather than sending an empty list', () => {
    expect(buildViolationFilterParams({ people: [] }, []).userIds).toBeUndefined();
  });

  it('produces one object for the list query and the bulk select-all payload alike', () => {
    // The bulk endpoints are only ever as narrow as the list: if these two
    // could differ, a select-all dismiss would reach past the visible rows.
    const filters = {
      severity: 'warning' as const,
      status: 'pending' as const,
      people: ['person-7'],
      rule: 'rule-2',
      occurred: { from: '2026-01-01' },
    };

    expect(buildViolationFilterParams(filters, ['server-a'])).toEqual(
      buildViolationFilterParams(filters, ['server-a'])
    );
  });
});
