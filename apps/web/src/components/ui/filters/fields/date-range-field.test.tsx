import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangeField } from './date-range-field';
import type { DateRangeValue } from '../types';

const labels = {
  placeholder: 'Any date',
  apply: 'Apply',
  cancel: 'Cancel',
  clear: 'Clear joined dates',
  clearStart: 'Clear start date',
  clearEnd: 'Clear end date',
};

function formatValue(value: DateRangeValue): string {
  if (value.from && value.to) return `${value.from} to ${value.to}`;
  if (value.from) return `after ${value.from}`;
  return `before ${value.to}`;
}

function renderField(value: DateRangeValue | undefined, onChange = vi.fn()) {
  render(
    <DateRangeField value={value} onChange={onChange} labels={labels} formatValue={formatValue} />
  );
  return onChange;
}

describe('DateRangeField', () => {
  it('shows the placeholder when nothing is set', () => {
    renderField(undefined);

    expect(screen.getByText('Any date')).toBeInTheDocument();
  });

  it('summarises an end-only bound, which TimeRangeValue cannot express', () => {
    renderField({ to: '2024-03-01' });

    expect(screen.getByText('before 2024-03-01')).toBeInTheDocument();
  });

  it('summarises a start-only bound', () => {
    renderField({ from: '2024-01-15' });

    expect(screen.getByText('after 2024-01-15')).toBeInTheDocument();
  });

  it('applies a one-sided range with the cleared end absent, not undefined', async () => {
    const user = userEvent.setup();
    const onChange = renderField({ from: '2024-01-15', to: '2024-03-01' });

    await user.click(screen.getByRole('button', { name: /2024-01-15 to 2024-03-01/ }));

    expect(screen.getByText('2024-01-15')).toBeInTheDocument();
    expect(screen.getByText('2024-03-01')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear start date' }));
    expect(screen.queryByText('2024-01-15')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const applied = onChange.mock.calls[0]?.[0] as DateRangeValue;
    expect(Object.keys(applied)).toEqual(['to']);
    expect(applied.to).toBe('2024-03-01');
  });

  it('applies nothing until Apply is pressed', async () => {
    const user = userEvent.setup();
    const onChange = renderField({ from: '2024-01-15', to: '2024-03-01' });

    await user.click(screen.getByRole('button', { name: /2024-01-15 to 2024-03-01/ }));
    await user.click(screen.getByRole('button', { name: 'Clear end date' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears both bounds to undefined from the trigger', async () => {
    const user = userEvent.setup();
    const onChange = renderField({ from: '2024-01-15' });

    await user.click(screen.getByRole('button', { name: 'Clear joined dates' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('applies an empty staged range as undefined rather than an empty object', async () => {
    const user = userEvent.setup();
    const onChange = renderField({ to: '2024-03-01' });

    await user.click(screen.getByRole('button', { name: /before 2024-03-01/ }));
    await user.click(screen.getByRole('button', { name: 'Clear end date' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
