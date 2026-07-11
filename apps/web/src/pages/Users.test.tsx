import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Users } from './Users';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useUsers: vi.fn(),
  useBulkResetTrust: () => ({ mutate: vi.fn(), isPending: false }),
  useMergeUsers: () => ({ mutate: vi.fn(), isPending: false }),
  useMergeSuggestions: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

import { useUsers } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

const mockUseUsers = vi.mocked(useUsers);
const mockUseServer = vi.mocked(useServer);
const mockUseAuth = vi.mocked(useAuth);

function renderUsers() {
  return render(
    <MemoryRouter>
      <Users />
    </MemoryRouter>
  );
}

describe('Users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
    } as unknown as ReturnType<typeof useServer>);
    mockUseAuth.mockReturnValue({
      user: { role: 'viewer' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows the users table once the list has loaded', () => {
    mockUseUsers.mockReturnValue({
      data: { data: [], total: 0, totalPages: 1 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useUsers>);

    renderUsers();

    expect(screen.getByText('pages:users.noUsersFound')).toBeInTheDocument();
  });

  it('shows an error state instead of the empty table when the users query fails, and retry refetches it', async () => {
    const refetch = vi.fn();
    mockUseUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('users failed'),
      refetch,
    } as unknown as ReturnType<typeof useUsers>);

    renderUsers();

    expect(screen.queryByText('pages:users.noUsersFound')).not.toBeInTheDocument();
    expect(screen.getByText('common:errors.somethingWentWrong')).toBeInTheDocument();
    expect(screen.getByText('users failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('wires a trust score header click into orderBy on the query, not a client-only sort', async () => {
    mockUseUsers.mockReturnValue({
      data: {
        data: [
          {
            id: 'su-1',
            userId: 'u-1',
            serverId: 'server-1',
            serverName: 'Server One',
            username: 'alice',
            identityName: 'Alice',
            identityTrustScore: 80,
            trustScore: 80,
            role: 'member',
            identityServers: [],
          },
        ],
        total: 1,
        totalPages: 1,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useUsers>);

    renderUsers();

    await userEvent.click(screen.getByText('common:labels.trustScore'));

    const calls = mockUseUsers.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall).toMatchObject({ orderBy: 'trustScore' });
    expect(['asc', 'desc']).toContain(lastCall?.orderDir);
  });
});
