import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server } from '@tracearr/shared';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ServerSelector } from './ServerSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useServer', () => ({ useServer: vi.fn() }));

import { useServer } from '@/hooks/useServer';

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'srv-plex',
    name: 'Plex Box',
    type: 'plex',
    color: '#ff9900',
    ...overrides,
  } as Server;
}

const jellyfin = server({ id: 'srv-jf', name: 'Jellyfin Box', type: 'jellyfin', color: '#00a4dc' });

const toggleServer = vi.fn();
const selectAllServers = vi.fn();
const deselectAllExcept = vi.fn();

function mockServers(servers: Server[], selectedServerIds: string[]) {
  vi.mocked(useServer).mockReturnValue({
    servers,
    selectedServerIds,
    isAllServersSelected: selectedServerIds.length === servers.length,
    toggleServer,
    selectAllServers,
    deselectAllExcept,
    isLoading: false,
    isFetching: false,
  } as unknown as ReturnType<typeof useServer>);
}

function renderSelector() {
  return render(
    <SidebarProvider>
      <ServerSelector />
    </SidebarProvider>
  );
}

beforeEach(() => {
  toggleServer.mockReset();
  selectAllServers.mockReset();
  deselectAllExcept.mockReset();
});

describe('ServerSelector', () => {
  it('renders a static label rather than a picker for a single server', () => {
    mockServers([server()], ['srv-plex']);
    renderSelector();

    expect(screen.getByText('Plex Box')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the one selected server instead of summarising by count', () => {
    mockServers([server(), jellyfin], ['srv-plex']);
    renderSelector();

    expect(screen.getByText('Plex Box')).toBeInTheDocument();
  });

  it('toggles the server that was actually clicked', async () => {
    const user = userEvent.setup();
    mockServers([server(), jellyfin], ['srv-plex', 'srv-jf']);
    renderSelector();

    await user.click(screen.getByRole('button', { name: /serverSelector.all/ }));
    await user.click(screen.getByText('Jellyfin Box'));

    expect(toggleServer).toHaveBeenCalledTimes(1);
    expect(toggleServer).toHaveBeenCalledWith('srv-jf');
  });

  it('collapses to the first server rather than clearing the selection', async () => {
    const user = userEvent.setup();
    mockServers([server(), jellyfin], ['srv-plex', 'srv-jf']);
    renderSelector();

    await user.click(screen.getByRole('button', { name: /serverSelector.all/ }));
    await user.click(screen.getByRole('button', { name: 'actions.deselectAll' }));

    expect(selectAllServers).not.toHaveBeenCalled();
    expect(deselectAllExcept).toHaveBeenCalledWith('srv-plex');
  });

  it('filters the list by search text', async () => {
    const user = userEvent.setup();
    mockServers([server(), jellyfin], ['srv-plex', 'srv-jf']);
    renderSelector();

    await user.click(screen.getByRole('button', { name: /serverSelector.all/ }));
    await user.type(screen.getByPlaceholderText('serverSelector.search'), 'jelly');

    expect(screen.getByText('Jellyfin Box')).toBeInTheDocument();
    expect(screen.queryByText('Plex Box')).not.toBeInTheDocument();
  });
});
