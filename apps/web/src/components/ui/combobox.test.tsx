import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Combobox, type ComboboxOption } from './combobox';

const options: ComboboxOption[] = [
  { value: 'session.bitrate', label: 'Bitrate', group: 'Session', description: 'Stream bitrate' },
  { value: 'session.player', label: 'Player', group: 'Session' },
  { value: 'user.trustScore', label: 'Trust score', group: 'User' },
];

function renderCombobox(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  const onChange = vi.fn();
  render(
    <Combobox
      value={null}
      onChange={onChange}
      options={options}
      placeholder="Select field"
      searchPlaceholder="Search fields"
      emptyText="No fields"
      {...props}
    />
  );
  return { onChange };
}

describe('Combobox', () => {
  it('shows the placeholder until something is picked', () => {
    renderCombobox();

    expect(screen.getByRole('combobox')).toHaveTextContent('Select field');
  });

  it('shows the selected option label', () => {
    renderCombobox({ value: 'user.trustScore' });

    expect(screen.getByRole('combobox')).toHaveTextContent('Trust score');
  });

  it('hands the picked option value to onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Trust score/ }));

    expect(onChange).toHaveBeenCalledWith('user.trustScore');
  });

  it('groups the options under their headings', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByText('Session')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('narrows the list as the user types and falls back to the empty text', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole('combobox'));
    await user.type(await screen.findByPlaceholderText('Search fields'), 'trust');

    expect(screen.queryByRole('option', { name: /Bitrate/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Trust score/ })).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Search fields'));
    await user.type(screen.getByPlaceholderText('Search fields'), 'zzz');

    expect(screen.getByText('No fields')).toBeInTheDocument();
  });

  it('stays shut while disabled', async () => {
    const user = userEvent.setup();
    renderCombobox({ disabled: true });

    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByPlaceholderText('Search fields')).not.toBeInTheDocument();
  });
});
