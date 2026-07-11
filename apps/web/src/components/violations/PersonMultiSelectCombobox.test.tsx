import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { PersonMultiSelectCombobox } from './PersonMultiSelectCombobox';

function option(userId: string, identityName: string): ServerUserWithIdentity {
  return {
    id: `su-${userId}`,
    userId,
    identityName,
    username: identityName.toLowerCase(),
    serverId: 'server-1',
    serverName: 'Plex',
    externalId: userId,
    thumbUrl: null,
    email: null,
    isServerAdmin: false,
    trustScore: 100,
    sessionCount: 0,
    joinedAt: null,
    lastActivityAt: null,
    removedAt: null,
    updatedAt: new Date(),
    role: 'member',
  } as unknown as ServerUserWithIdentity;
}

const options = [option('user-1', 'Alice'), option('user-2', 'Bob')];

function renderCombobox(
  overrides: Partial<React.ComponentProps<typeof PersonMultiSelectCombobox>> = {}
) {
  const onChange = vi.fn();
  render(
    <PersonMultiSelectCombobox
      value={[]}
      onChange={onChange}
      options={options}
      allLabel="All people"
      countLabel={(count) => `${count} people`}
      searchPlaceholder="Search people..."
      emptyMessage="No matching people found"
      errorMessage="Failed to load people"
      loadingMessage="Loading..."
      {...overrides}
    />
  );
  return { onChange };
}

describe('PersonMultiSelectCombobox', () => {
  it('shows the all-people label on the trigger when nothing is selected', () => {
    renderCombobox();
    expect(screen.getByRole('combobox')).toHaveTextContent('All people');
  });

  it("shows the person's name when exactly one is selected", () => {
    renderCombobox({ value: ['user-1'] });
    expect(screen.getByRole('combobox')).toHaveTextContent('Alice');
  });

  it('shows the count label when several people are selected', () => {
    renderCombobox({ value: ['user-1', 'user-2'] });
    expect(screen.getByRole('combobox')).toHaveTextContent('2 people');
  });

  it('adds a person to the selection when their row is chosen from the open list', async () => {
    const { onChange } = renderCombobox();

    await userEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Alice'));

    expect(onChange).toHaveBeenCalledWith(['user-1']);
  });

  it('removes a person from the selection when their already-checked row is chosen again', async () => {
    const { onChange } = renderCombobox({ value: ['user-1', 'user-2'] });

    await userEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Alice'));

    expect(onChange).toHaveBeenCalledWith(['user-2']);
  });

  it('clears the whole selection via the trigger clear action', async () => {
    const { onChange } = renderCombobox({ value: ['user-1', 'user-2'] });

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows the loading state inside the list instead of the option rows', async () => {
    renderCombobox({ isLoading: true });

    await userEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByText('Loading...')).toBeInTheDocument());
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('shows the error state inside the list when the roster failed to load', async () => {
    renderCombobox({ isError: true });

    await userEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByText('Failed to load people')).toBeInTheDocument());
  });

  it('debounces typed search before forwarding it via onSearchChange', async () => {
    const onSearchChange = vi.fn();
    renderCombobox({ onSearchChange });

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByPlaceholderText('Search people...'), 'ali');

    expect(onSearchChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith('ali'));
  });
});
