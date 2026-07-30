import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlayedStateSyncStatusResponse } from '@tracearr/shared';
import { PlayedStateSettings } from './PlayedStateSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  usePlayedStateStatus: vi.fn(),
  usePlayedStateSync: vi.fn(),
}));

import { useAuth } from '@/hooks/useAuth';
import { usePlayedStateStatus, usePlayedStateSync } from '@/hooks/queries';

const mockUseAuth = vi.mocked(useAuth);
const mockUseStatus = vi.mocked(usePlayedStateStatus);
const mockUseSync = vi.mocked(usePlayedStateSync);

function statusReturn(
  overrides: Partial<PlayedStateSyncStatusResponse> = {}
): ReturnType<typeof usePlayedStateStatus> {
  return {
    data: {
      servers: [
        {
          serverId: 'srv-emby',
          serverName: 'Emby Server',
          capability: 'supported',
          status: 'success',
          startedAt: '2026-07-29T00:00:00Z',
          completedAt: '2026-07-29T00:05:00Z',
          usersTotal: 10,
          usersSynced: 10,
          itemsUpserted: 500,
          itemsPruned: 3,
          error: null,
        },
        {
          serverId: 'srv-plex',
          serverName: 'Plex Server',
          capability: 'unsupported',
          status: 'never_run',
          startedAt: null,
          completedAt: null,
          usersTotal: 0,
          usersSynced: 0,
          itemsUpserted: 0,
          itemsPruned: 0,
          error: null,
        },
      ],
      ...overrides,
    },
    isLoading: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePlayedStateStatus>;
}

function syncReturn(
  overrides: Partial<ReturnType<typeof usePlayedStateSync>> = {}
): ReturnType<typeof usePlayedStateSync> {
  return {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
    ...overrides,
  } as unknown as ReturnType<typeof usePlayedStateSync>;
}

describe('PlayedStateSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
    mockUseStatus.mockReturnValue(statusReturn());
    mockUseSync.mockReturnValue(syncReturn());
  });

  it('renders a card per server with its sync status', () => {
    render(<PlayedStateSettings />);

    expect(screen.getByText('Emby Server')).toBeInTheDocument();
    expect(screen.getByText('Plex Server')).toBeInTheDocument();
    expect(screen.getByText('settings:playedState.statusSuccess')).toBeInTheDocument();
  });

  it('marks the Plex server as unsupported and hides its Sync Now button', () => {
    render(<PlayedStateSettings />);

    expect(screen.getByText('settings:playedState.capabilityUnsupported')).toBeInTheDocument();
    // Only the Emby (supported) server gets a Sync Now button.
    expect(screen.getAllByRole('button', { name: 'settings:playedState.syncNow' })).toHaveLength(1);
  });

  it('triggers a sync for the clicked server (owner role)', async () => {
    const mutate = vi.fn();
    mockUseSync.mockReturnValue(syncReturn({ mutate }));

    render(<PlayedStateSettings />);

    await userEvent.click(screen.getByRole('button', { name: 'settings:playedState.syncNow' }));

    expect(mutate).toHaveBeenCalledWith('srv-emby');
  });

  it('hides the Sync Now button entirely for a non-admin/owner role', () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'member' },
    } as unknown as ReturnType<typeof useAuth>);

    render(<PlayedStateSettings />);

    expect(
      screen.queryByRole('button', { name: 'settings:playedState.syncNow' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('settings:playedState.ownerOnlyNote')).toBeInTheDocument();
  });

  it('disables Sync Now while a run is already in progress for that server', () => {
    mockUseStatus.mockReturnValue(
      statusReturn({
        servers: [
          {
            serverId: 'srv-emby',
            serverName: 'Emby Server',
            capability: 'supported',
            status: 'running',
            startedAt: '2026-07-29T00:00:00Z',
            completedAt: null,
            usersTotal: 10,
            usersSynced: 4,
            itemsUpserted: 200,
            itemsPruned: 0,
            error: null,
          },
        ],
      })
    );

    render(<PlayedStateSettings />);

    expect(screen.getByRole('button', { name: /syncing/i })).toBeDisabled();
  });

  it('shows the last error message for a partial/error run', () => {
    mockUseStatus.mockReturnValue(
      statusReturn({
        servers: [
          {
            serverId: 'srv-emby',
            serverName: 'Emby Server',
            capability: 'supported',
            status: 'error',
            startedAt: '2026-07-29T00:00:00Z',
            completedAt: '2026-07-29T00:01:00Z',
            usersTotal: 10,
            usersSynced: 0,
            itemsUpserted: 0,
            itemsPruned: 0,
            error: 'Server unreachable',
          },
        ],
      })
    );

    render(<PlayedStateSettings />);

    expect(screen.getByText(/Server unreachable/)).toBeInTheDocument();
  });

  it('shows an empty state when no servers are configured', () => {
    mockUseStatus.mockReturnValue(statusReturn({ servers: [] }));

    render(<PlayedStateSettings />);

    expect(screen.getByText('settings:playedState.noServers')).toBeInTheDocument();
  });
});
