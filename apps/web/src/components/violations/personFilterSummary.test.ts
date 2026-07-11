import { describe, it, expect } from 'vitest';
import { summarizePersonSelection } from './personFilterSummary';

const names: Record<string, string> = {
  'user-1': 'Alice',
  'user-2': 'Bob',
};
const resolveName = (id: string) => names[id];
const countLabel = (count: number) => `${count} people`;

describe('summarizePersonSelection', () => {
  it('returns the all-people label when nothing is selected', () => {
    expect(summarizePersonSelection([], resolveName, 'All people', countLabel)).toBe('All people');
  });

  it('returns the resolved name when exactly one person is selected', () => {
    expect(summarizePersonSelection(['user-1'], resolveName, 'All people', countLabel)).toBe(
      'Alice'
    );
  });

  it('falls back to the count label when the single selected id has no resolvable name', () => {
    expect(summarizePersonSelection(['unknown'], resolveName, 'All people', countLabel)).toBe(
      '1 people'
    );
  });

  it('returns the count label when several people are selected', () => {
    expect(
      summarizePersonSelection(['user-1', 'user-2'], resolveName, 'All people', countLabel)
    ).toBe('2 people');
  });

  it('uses the count label for larger selections too', () => {
    expect(
      summarizePersonSelection(
        ['user-1', 'user-2', 'user-3'],
        resolveName,
        'All people',
        countLabel
      )
    ).toBe('3 people');
  });
});
