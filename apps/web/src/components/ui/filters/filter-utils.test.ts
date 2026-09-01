import { describe, it, expect } from 'vitest';
import {
  activeFilterChips,
  countActiveFilters,
  filtersFromSearchParams,
  filtersToSearchParams,
  normalizeFilterValue,
  setFilterValue,
  validateFilters,
} from './filter-utils';
import type { FilterDescriptor, FilterState } from './types';

const dateLabels = {
  placeholder: 'Any date',
  apply: 'Apply',
  cancel: 'Cancel',
  clear: 'Clear dates',
  clearStart: 'Clear start date',
  clearEnd: 'Clear end date',
};

function descriptors(overrides: Record<string, FilterDescriptor> = {}): FilterDescriptor[] {
  const base: Record<string, FilterDescriptor> = {
    search: {
      kind: 'search',
      key: 'search',
      label: 'Search',
      placeholder: 'Search users',
      clearLabel: 'Clear search',
      inline: true,
    },
    serverIds: {
      kind: 'multiSelect',
      key: 'serverIds',
      label: 'Servers',
      options: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ],
      placeholder: 'All servers',
      searchPlaceholder: 'Find a server',
      emptyMessage: 'No servers',
      clearLabel: 'Clear servers',
      countLabel: (count) => `${count} servers`,
    },
    role: {
      kind: 'select',
      key: 'role',
      label: 'Role',
      options: [
        { value: 'admin', label: 'Admin' },
        { value: 'member', label: 'Member' },
      ],
      allLabel: 'Any role',
    },
    joined: {
      kind: 'dateRange',
      key: 'joined',
      label: 'Joined',
      labels: dateLabels,
      formatValue: (value) => `${value.from ?? '*'}/${value.to ?? '*'}`,
    },
    showRemoved: {
      kind: 'boolean',
      key: 'showRemoved',
      label: 'Show removed',
    },
  };
  return Object.values({ ...base, ...overrides });
}

describe('normalizeFilterValue', () => {
  it('collapses every empty spelling to undefined', () => {
    expect(normalizeFilterValue('search', '')).toBeUndefined();
    expect(normalizeFilterValue('search', '   ')).toBeUndefined();
    expect(normalizeFilterValue('multiSelect', [])).toBeUndefined();
    expect(normalizeFilterValue('select', '')).toBeUndefined();
    expect(normalizeFilterValue('boolean', false)).toBeUndefined();
    expect(normalizeFilterValue('dateRange', {})).toBeUndefined();
    expect(normalizeFilterValue('dateRange', { from: undefined, to: undefined })).toBeUndefined();
  });

  it('trims search text and keeps a populated range one-sided', () => {
    expect(normalizeFilterValue('search', '  bob ')).toBe('bob');
    expect(normalizeFilterValue('dateRange', { to: '2024-03-01' })).toEqual({ to: '2024-03-01' });
  });

  it('drops date parts that are not ISO calendar dates', () => {
    expect(normalizeFilterValue('dateRange', { from: '2024-13-40', to: '2024-03-01' })).toEqual({
      to: '2024-03-01',
    });
    expect(normalizeFilterValue('dateRange', { from: '2024-03-01T10:00:00Z' })).toBeUndefined();
  });
});

describe('setFilterValue', () => {
  it('deletes the key rather than storing null or an empty array', () => {
    const state: FilterState = { search: 'bob', serverIds: ['alpha'] };

    const cleared = setFilterValue(state, 'serverIds', undefined);

    expect(cleared.serverIds).toBeUndefined();
    expect(Object.keys(cleared)).toEqual(['search']);
    expect(JSON.stringify(cleared)).toBe('{"search":"bob"}');
  });

  it('leaves the source object untouched', () => {
    const state: FilterState = { search: 'bob' };
    setFilterValue(state, 'search', undefined);
    expect(state.search).toBe('bob');
  });
});

describe('filtersToSearchParams and filtersFromSearchParams', () => {
  it('round trips every kind', () => {
    const state: FilterState = {
      search: 'bob',
      serverIds: ['alpha', 'beta'],
      role: 'admin',
      joined: { from: '2024-01-15', to: '2024-03-01' },
      showRemoved: true,
    };

    const params = filtersToSearchParams(state, descriptors());

    expect(params.get('search')).toBe('bob');
    expect(params.getAll('serverIds')).toEqual(['alpha', 'beta']);
    expect(params.get('role')).toBe('admin');
    expect(params.get('joinedFrom')).toBe('2024-01-15');
    expect(params.get('joinedTo')).toBe('2024-03-01');
    expect(params.get('showRemoved')).toBe('1');

    expect(filtersFromSearchParams(params, descriptors())).toEqual(state);
  });

  it('round trips a one-sided range without inventing the other bound', () => {
    const params = filtersToSearchParams({ joined: { to: '2024-03-01' } }, descriptors());

    expect(params.has('joinedFrom')).toBe(false);
    expect(params.get('joinedTo')).toBe('2024-03-01');

    const parsed = filtersFromSearchParams(params, descriptors());

    expect(parsed.joined).toEqual({ to: '2024-03-01' });
    expect(JSON.stringify(parsed.joined)).toBe('{"to":"2024-03-01"}');
  });

  it('emits no params for an empty state and parses one back to an empty state', () => {
    const params = filtersToSearchParams({}, descriptors());

    expect([...params.keys()]).toEqual([]);
    expect(filtersFromSearchParams(params, descriptors())).toEqual({});
  });

  it('parses a missing boolean as undefined rather than false', () => {
    const parsed = filtersFromSearchParams(new URLSearchParams(), descriptors());

    expect(parsed.showRemoved).toBeUndefined();
    expect('showRemoved' in parsed).toBe(false);
  });

  it('accepts either flag spelling for a boolean', () => {
    expect(filtersFromSearchParams(new URLSearchParams('showRemoved=1'), descriptors())).toEqual({
      showRemoved: true,
    });
    expect(filtersFromSearchParams(new URLSearchParams('showRemoved=true'), descriptors())).toEqual(
      {
        showRemoved: true,
      }
    );
  });

  it('keeps params it does not own and clears the ones it does', () => {
    const base = new URLSearchParams('page=3&search=stale&serverIds=alpha');

    const params = filtersToSearchParams({ role: 'admin' }, descriptors(), base);

    expect(params.get('page')).toBe('3');
    expect(params.has('search')).toBe(false);
    expect(params.getAll('serverIds')).toEqual([]);
    expect(params.get('role')).toBe('admin');
  });
});

describe('validateFilters', () => {
  it('drops a selection whose option no longer exists', () => {
    const validated = validateFilters({ serverIds: ['alpha', 'gone'] }, descriptors());

    expect(validated.serverIds).toEqual(['alpha']);
  });

  it('drops the whole key when nothing survives', () => {
    const validated = validateFilters({ serverIds: ['gone'], role: 'ghost' }, descriptors());

    expect(validated.serverIds).toBeUndefined();
    expect(validated.role).toBeUndefined();
    expect(Object.keys(validated)).toEqual([]);
  });

  it('leaves values alone while the option list has not loaded', () => {
    const loading = descriptors({
      serverIds: {
        kind: 'multiSelect',
        key: 'serverIds',
        label: 'Servers',
        options: undefined,
        placeholder: 'All servers',
        searchPlaceholder: 'Find a server',
        emptyMessage: 'No servers',
        clearLabel: 'Clear servers',
        countLabel: (count) => `${count} servers`,
      },
    });

    expect(validateFilters({ serverIds: ['alpha', 'gone'] }, loading).serverIds).toEqual([
      'alpha',
      'gone',
    ]);
  });

  it('returns the same reference when nothing changed', () => {
    const state: FilterState = { search: 'bob', serverIds: ['alpha'] };

    expect(validateFilters(state, descriptors())).toBe(state);
  });
});

describe('countActiveFilters and activeFilterChips', () => {
  it('counts only keys that are actually set', () => {
    expect(countActiveFilters(descriptors(), {})).toBe(0);
    expect(
      countActiveFilters(descriptors(), { search: '  ', serverIds: [], showRemoved: false })
    ).toBe(0);
    expect(countActiveFilters(descriptors(), { search: 'bob', showRemoved: true })).toBe(2);
  });

  it('labels each chip from the descriptor rather than the raw value', () => {
    const chips = activeFilterChips(descriptors(), {
      search: 'bob',
      serverIds: ['alpha'],
      role: 'admin',
      joined: { to: '2024-03-01' },
      showRemoved: true,
    });

    expect(chips).toEqual([
      { key: 'serverIds', label: 'Servers', value: 'Alpha' },
      { key: 'role', label: 'Role', value: 'Admin' },
      { key: 'joined', label: 'Joined', value: '*/2024-03-01' },
      { key: 'showRemoved', label: 'Show removed', value: '' },
    ]);
  });

  it('leaves an inline field out of the chip row, where its own box already shows it', () => {
    const chips = activeFilterChips(descriptors(), { search: 'bob' });

    expect(chips).toEqual([]);
  });

  it('summarises a multi selection with the caller-supplied count label', () => {
    const [chip] = activeFilterChips(descriptors(), { serverIds: ['alpha', 'beta'] });

    expect(chip?.value).toBe('2 servers');
  });
});
