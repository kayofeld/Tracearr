import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { UserCell } from './UserCell';

function renderCell(props: Partial<React.ComponentProps<typeof UserCell>> = {}) {
  render(
    <MemoryRouter>
      <UserCell serverUserId="su-1" username="rebecc101" identityName="Rebecca Lin" {...props} />
    </MemoryRouter>
  );
}

describe('UserCell', () => {
  it('leads with the display name and puts the account under it', () => {
    renderCell({ showUsername: true });

    expect(screen.getByText('Rebecca Lin')).toBeInTheDocument();
    expect(screen.getByText('@rebecc101')).toBeInTheDocument();
  });

  it('falls back to the account name, and does not repeat it underneath', () => {
    renderCell({ identityName: null, showUsername: true });

    expect(screen.getByText('rebecc101')).toBeInTheDocument();
    expect(screen.queryByText('@rebecc101')).not.toBeInTheDocument();
  });

  it('links to the account without opening whatever the row opens', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <MemoryRouter>
        <button type="button" onClick={onRowClick}>
          <UserCell serverUserId="su-1" username="rebecc101" identityName="Rebecca Lin" />
        </button>
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: 'Rebecca Lin' });
    expect(link).toHaveAttribute('href', '/users/su-1');

    await user.click(link);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('leaves the link out when the caller owns the click', () => {
    renderCell({ link: false });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Rebecca Lin')).toBeInTheDocument();
  });

  it('says nothing where the account it named is gone', () => {
    renderCell({ serverUserId: null, username: null, identityName: null });

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('strikes through a removed account and carries what the caller put beside it', () => {
    renderCell({ muted: true, trailing: <span>owner</span> });

    expect(screen.getByText('Rebecca Lin')).toHaveClass('line-through');
    expect(screen.getByText('owner')).toBeInTheDocument();
  });
});
