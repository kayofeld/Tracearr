import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router';
import { Map as MapPage } from './Map';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/map/StreamMap', () => ({
  StreamMap: () => <div data-testid="stream-map" />,
}));

vi.mock('@/hooks/queries', () => ({
  useLocationStats: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

import { useLocationStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseLocationStats = vi.mocked(useLocationStats);
const mockUseServer = vi.mocked(useServer);

function renderMap() {
  return render(
    <MemoryRouter>
      <MapPage />
    </MemoryRouter>
  );
}

function renderMapAtUrl(url: string) {
  const router = createMemoryRouter([{ path: '/map', element: <MapPage /> }], {
    initialEntries: [url],
  });
  const utils = render(<RouterProvider router={router} />);
  return { router, ...utils };
}

describe('Map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      isMultiServer: false,
    } as unknown as ReturnType<typeof useServer>);
  });

  it('shows the map once locations have loaded', async () => {
    mockUseLocationStats.mockReturnValue({
      data: { data: [], summary: undefined, availableFilters: undefined },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useLocationStats>);

    renderMap();

    expect(await screen.findByTestId('stream-map')).toBeInTheDocument();
  });

  it('shows an error state instead of the map when the locations query fails, and retry refetches it', async () => {
    const refetch = vi.fn();
    mockUseLocationStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('locations failed'),
      refetch,
    } as unknown as ReturnType<typeof useLocationStats>);

    renderMap();

    expect(screen.queryByTestId('stream-map')).not.toBeInTheDocument();
    expect(screen.getByText('common:errors.somethingWentWrong')).toBeInTheDocument();
    expect(screen.getByText('locations failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('clears a selected user filter that no longer appears in the current options', async () => {
    mockUseLocationStats.mockReturnValue({
      data: {
        data: [],
        summary: { totalStreams: 0, uniqueLocations: 0, topCity: null },
        availableFilters: {
          users: [
            {
              id: 'other-user',
              username: 'bob',
              identityName: null,
              serverUserIds: ['other-user'],
            },
          ],
          servers: [],
          mediaTypes: [],
        },
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useLocationStats>);

    const { router } = renderMapAtUrl('/map?serverUserId=stale-user&serverUserIds=stale-user');

    await waitFor(() => expect(router.state.location.search).not.toContain('serverUserId'));
  });

  it('keeps a selected user filter that is still present in the current options', async () => {
    mockUseLocationStats.mockReturnValue({
      data: {
        data: [],
        summary: { totalStreams: 0, uniqueLocations: 0, topCity: null },
        availableFilters: {
          users: [
            {
              id: 'alice-rep',
              username: 'alice_plex',
              identityName: 'Alice',
              serverUserIds: ['alice-rep', 'alice-secondary'],
            },
          ],
          servers: [],
          mediaTypes: [],
        },
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useLocationStats>);

    const { router } = renderMapAtUrl(
      '/map?serverUserId=alice-rep&serverUserIds=alice-rep%2Calice-secondary'
    );

    await waitFor(() => expect(screen.getAllByText('Alice').length).toBeGreaterThan(0));
    expect(router.state.location.search).toContain('serverUserId=alice-rep');
    expect(router.state.location.search).toContain('serverUserIds=alice-rep%2Calice-secondary');
  });
});
