import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchField } from './search-field';

const DEBOUNCE_MS = 10;

function setup(value: string | undefined, onChange = vi.fn()) {
  const user = userEvent.setup();
  render(
    <SearchField
      value={value}
      onChange={onChange}
      placeholder="Search users"
      clearLabel="Clear search"
      debounceMs={DEBOUNCE_MS}
      aria-label="Search"
    />
  );
  return { user, onChange };
}

describe('SearchField', () => {
  it('commits a trimmed value once the debounce lands', async () => {
    const { user, onChange } = setup(undefined);

    await user.type(screen.getByRole('textbox', { name: 'Search' }), ' bob ');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('bob'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('commits undefined rather than an empty string when the text is erased', async () => {
    const { user, onChange } = setup('bob');

    await user.clear(screen.getByRole('textbox', { name: 'Search' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
  });

  it('clears immediately from the clear button', async () => {
    const { user, onChange } = setup('bob');

    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('does not re-commit a value that already matches the prop', async () => {
    const { onChange } = setup('bob');

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 10));

    expect(onChange).not.toHaveBeenCalled();
  });
});
