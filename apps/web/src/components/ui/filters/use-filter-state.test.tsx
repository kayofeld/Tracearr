import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { useFilterState, type FilterPersistence } from './use-filter-state';
import type { FilterDescriptor, FilterState } from './types';

const DEFAULTS: FilterState = {};

const DESCRIPTORS: FilterDescriptor[] = [
  {
    kind: 'search',
    key: 'search',
    label: 'Search',
    placeholder: 'Search users',
    clearLabel: 'Clear search',
  },
  {
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
  {
    kind: 'dateRange',
    key: 'joined',
    label: 'Joined',
    labels: {
      placeholder: 'Any date',
      apply: 'Apply',
      cancel: 'Cancel',
      clear: 'Clear joined dates',
      clearStart: 'Clear start date',
      clearEnd: 'Clear end date',
    },
    formatValue: (value) => `${value.from ?? '*'}/${value.to ?? '*'}`,
  },
];

function renderFilterState(persistence: FilterPersistence, entry = '/users', storageKey?: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );

  return renderHook(
    () => {
      const state = useFilterState({
        descriptors: DESCRIPTORS,
        defaults: DEFAULTS,
        persistence,
        storageKey,
      });
      return { ...state, search: useLocation().search };
    },
    { wrapper }
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('useFilterState url persistence', () => {
  it('reads filters out of the query string', () => {
    const { result } = renderFilterState(
      'url',
      '/users?search=bob&serverIds=alpha&serverIds=beta&joinedTo=2024-03-01'
    );

    expect(result.current.filters).toEqual({
      search: 'bob',
      serverIds: ['alpha', 'beta'],
      joined: { to: '2024-03-01' },
    });
  });

  it('writes filters back to the query string and keeps unrelated params', () => {
    const { result } = renderFilterState('url', '/users?page=3');

    act(() => result.current.setFilters({ search: 'bob', joined: { from: '2024-01-15' } }));

    const params = new URLSearchParams(result.current.search);
    expect(params.get('page')).toBe('3');
    expect(params.get('search')).toBe('bob');
    expect(params.get('joinedFrom')).toBe('2024-01-15');
    expect(params.has('joinedTo')).toBe(false);
  });

  it('drops a param a descriptor no longer recognises', () => {
    const { result } = renderFilterState('url', '/users?serverIds=alpha&serverIds=gone');

    expect(result.current.filters.serverIds).toEqual(['alpha']);
  });

  it('removes the param when a filter is cleared', () => {
    const { result } = renderFilterState('url', '/users?search=bob');

    act(() => result.current.setFilter('search', undefined));

    expect(result.current.search).toBe('');
    expect(result.current.filters.search).toBeUndefined();
  });

  it('resets to the defaults constant', () => {
    const { result } = renderFilterState('url', '/users?search=bob&serverIds=alpha');

    act(() => result.current.reset());

    expect(result.current.filters).toEqual(DEFAULTS);
    expect(result.current.search).toBe('');
  });
});

describe('useFilterState local persistence', () => {
  it('seeds from storage and validates what it finds', () => {
    localStorage.setItem(
      'tracearr_test_filters',
      JSON.stringify({ search: 'bob', serverIds: ['gone'] })
    );

    const { result } = renderFilterState('local', '/users', 'tracearr_test_filters');

    expect(result.current.filters).toEqual({ search: 'bob' });
  });

  it('writes every change back to storage', () => {
    const { result } = renderFilterState('local', '/users', 'tracearr_test_filters');

    act(() => result.current.setFilter('serverIds', ['beta']));

    expect(JSON.parse(localStorage.getItem('tracearr_test_filters') ?? '{}')).toEqual({
      serverIds: ['beta'],
    });
    expect(result.current.search).toBe('');
  });

  it('falls back to the defaults when the stored blob is corrupt', () => {
    localStorage.setItem('tracearr_test_filters', '{not json');

    const { result } = renderFilterState('local', '/users', 'tracearr_test_filters');

    expect(result.current.filters).toEqual(DEFAULTS);
  });
});

describe('useFilterState memory persistence', () => {
  it('keeps state off the URL and out of storage', () => {
    const { result } = renderFilterState('memory');

    act(() => result.current.setFilter('search', 'bob'));

    expect(result.current.filters).toEqual({ search: 'bob' });
    expect(result.current.search).toBe('');
    expect(localStorage.length).toBe(0);
  });
});
