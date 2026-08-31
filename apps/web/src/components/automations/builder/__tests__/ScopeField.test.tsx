import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AutomationScope } from '@/lib/automations';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { ServerProvider } from '@/hooks/useServer';
import { ScopeField } from '../ScopeField';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { role: 'owner', serverIds: [] } }),
}));

const { roster } = vi.hoisted(() => ({
  roster: vi.fn<() => { data: { data: ServerUserWithIdentity[] } | undefined }>(),
}));

vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => roster() }));

const listServers = vi.fn<() => Promise<Server[]>>();

vi.mock('@/lib/api', () => ({
  api: { servers: { list: () => listServers() } },
}));

function server(id: string, name: string): Server {
  return {
    id,
    name,
    type: 'plex',
    url: '',
    color: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const SCOPE_MODES = ['global', 'server', 'account', 'person'].map(
  (mode) => `automations.builder.scope.${mode}`
);

function renderField(client: QueryClient, scope: AutomationScope = { mode: 'global' }) {
  return render(
    <QueryClientProvider client={client}>
      <ServerProvider>
        <ScopeField
          scope={scope}
          onChange={vi.fn()}
          enforceAcrossServers={false}
          onEnforceAcrossServersChange={vi.fn()}
          canEnforceAcrossServers={false}
        />
      </ServerProvider>
    </QueryClientProvider>
  );
}

function offeredModes() {
  return screen
    .getAllByRole('radio')
    .map((option) => option.textContent)
    .filter((label) => label !== null);
}

describe('ScopeField', () => {
  beforeEach(() => {
    localStorage.clear();
    listServers.mockReset();
    roster.mockReset();
    roster.mockReturnValue({ data: undefined });
  });

  it('offers two scopes while one server is connected', async () => {
    listServers.mockResolvedValue([server('s1', 'One')]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderField(client);

    await waitFor(() => expect(offeredModes()).toHaveLength(2));
    expect(offeredModes()).toEqual([SCOPE_MODES[0], SCOPE_MODES[2]]);
  });

  it('opens both pickers filled in for a stored account scope', async () => {
    listServers.mockResolvedValue([server('s1', 'One'), server('s2', 'Two')]);
    roster.mockReturnValue({
      data: {
        data: [
          {
            id: 'su-2',
            serverId: 's2',
            username: 'connor',
            identityName: 'Connor',
          } as ServerUserWithIdentity,
        ],
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderField(client, { mode: 'account', serverId: 's2', serverUserId: 'su-2' });

    await waitFor(() => expect(screen.getByText('Two')).toBeInTheDocument());
    expect(screen.getByText('Connor')).toBeInTheDocument();
  });

  it('picks up a second server as soon as the server list is invalidated', async () => {
    listServers.mockResolvedValue([server('s1', 'One')]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderField(client);
    await waitFor(() => expect(offeredModes()).toHaveLength(2));

    // What every server mutation does on success.
    listServers.mockResolvedValue([server('s1', 'One'), server('s2', 'Two')]);
    await client.invalidateQueries({ queryKey: ['servers', 'list'] });

    await waitFor(() => expect(offeredModes()).toEqual(SCOPE_MODES));
  });
});
