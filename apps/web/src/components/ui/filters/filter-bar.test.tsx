import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterBar } from './filter-bar';
import type { FilterDescriptor, FilterState } from './types';

const DEFAULTS: FilterState = {};

const labels = {
  trigger: 'Filters',
  panelTitle: 'Filter users',
  clearAll: 'Clear all',
  done: 'Done',
  removeFilter: (label: string) => `Remove ${label} filter`,
};

const descriptors: FilterDescriptor[] = [
  {
    kind: 'search',
    key: 'search',
    label: 'Search',
    placeholder: 'Search users',
    clearLabel: 'Clear search',
    inline: true,
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
    kind: 'boolean',
    key: 'showRemoved',
    label: 'Show removed',
  },
];

function renderBar(value: FilterState, onChange = vi.fn()) {
  render(
    <FilterBar
      descriptors={descriptors}
      value={value}
      onChange={onChange}
      defaults={DEFAULTS}
      labels={labels}
    />
  );
  return onChange;
}

describe('FilterBar', () => {
  it('renders no chip row while nothing is set', () => {
    renderBar({});

    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('offers Clear all for a typed query alone, which draws no chip of its own', () => {
    renderBar({ search: 'bob' });

    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Search filter' })).not.toBeInTheDocument();
  });

  it('counts only panel filters on the trigger badge', () => {
    renderBar({ search: 'bob', serverIds: ['alpha'], showRemoved: true });

    expect(screen.getByRole('button', { name: /Filters/ })).toHaveTextContent('2');
  });

  it('drives chips off the panel descriptors, leaving the typed query in its own box', () => {
    renderBar({ search: 'bob', serverIds: ['alpha', 'beta'], showRemoved: true });

    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('bob');
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    expect(screen.getByText('2 servers')).toBeInTheDocument();
    expect(screen.getByText('Show removed')).toBeInTheDocument();
  });

  it('removes one filter as undefined, leaving the rest untouched', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ search: 'bob', serverIds: ['alpha'] });

    await user.click(screen.getByRole('button', { name: 'Remove Servers filter' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as FilterState;
    expect(next.serverIds).toBeUndefined();
    expect(Object.keys(next)).toEqual(['search']);
  });

  it('clears everything back to the defaults constant', async () => {
    const user = userEvent.setup();
    const onChange = renderBar({ search: 'bob', showRemoved: true });

    await user.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(onChange).toHaveBeenCalledWith(DEFAULTS);
  });

  it('opens the desktop panel with a labelled control per panel descriptor', async () => {
    const user = userEvent.setup();
    renderBar({});

    await user.click(screen.getByRole('button', { name: /Filters/ }));

    expect(screen.getByRole('combobox', { name: 'Servers' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show removed' })).toBeInTheDocument();
  });
});
