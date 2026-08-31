import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initI18n } from '@tracearr/translations';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Automation } from '@tracearr/shared';
import { TEMPLATES } from '@/components/automations/gallery/__tests__/fixtures';
import { Automations } from './Automations';

const toggleMutate = vi.fn();
const deleteMutate = vi.fn();

const { mockUseTemplates, mockUseServer } = vi.hoisted(() => ({
  mockUseTemplates: vi.fn(),
  mockUseServer: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  useAutomations: vi.fn(),
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
  useToggleAutomation: () => ({ mutate: toggleMutate, isPending: false }),
  useDeleteAutomation: () => ({ mutate: deleteMutate, isPending: false }),
  useBulkToggleAutomations: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteAutomations: () => ({ mutate: vi.fn(), isPending: false }),
  useTemplates: mockUseTemplates,
}));

vi.mock('@/hooks/queries/useTemplates', () => ({
  useTemplates: () => ({ data: TEMPLATES, isLoading: false, isError: false, refetch: vi.fn() }),
  useInstantiateTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useImportTemplate: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));

vi.mock('@/hooks/queries/useDestinations', () => ({ useDestinations: () => ({ data: [] }) }));

vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));

vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useServer', () => ({ useServer: mockUseServer }));

const SERVERS = [{ id: 'server-1', name: 'Server One' }];

import { useAutomations } from '@/hooks/queries';

const mockUseAutomations = vi.mocked(useAutomations);

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Concurrent cap',
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [],
    conditions: {
      groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 3 }] }],
    },
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef: null,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockList(rows: Automation[], total = rows.length) {
  mockUseAutomations.mockReturnValue({
    data: { data: rows, meta: { page: 1, pageSize: 20, total } },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAutomations>);
}

function lastQueryArgs() {
  const calls = mockUseAutomations.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function bodyRows() {
  const table = screen.getByRole('table');
  const [, ...bodies] = within(table).getAllByRole('rowgroup');
  return bodies.flatMap((body) => within(body).queryAllByRole('row'));
}

function renderAutomations(path = '/automations') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {/* Layout's SidebarProvider carries this in the app. */}
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/automations" element={<Automations />} />
            <Route path="/automations/new" element={<p>the builder page</p>} />
            <Route path="/automations/:id" element={<p>the automation detail</p>} />
            <Route path="/automations/:id/edit" element={<p>the builder page</p>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const openedDetail = () => screen.queryByText('the automation detail');
const openedBuilder = () => screen.queryByText('the builder page');

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('Automations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTemplates.mockReturnValue({
      data: TEMPLATES,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseServer.mockReturnValue({ servers: SERVERS });
    mockList([automation()]);
  });

  it('renders one row per automation with its translated kind badge', () => {
    mockList([automation(), automation({ id: 'a-2', name: 'Nudge', kind: 'notification' })]);

    renderAutomations();

    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByText('Concurrent cap')).toBeInTheDocument();
    expect(screen.getByText('Violation')).toBeInTheDocument();
    expect(screen.getByText('Alert')).toBeInTheDocument();
  });

  it('sends a deep-linked server on to the query', () => {
    renderAutomations('/automations?serverId=server-1');

    expect(lastQueryArgs()).toMatchObject({ serverId: 'server-1' });
  });

  it('keeps that server through the render before the servers have loaded', () => {
    // An empty options list would read as "no such server" and drop the param.
    mockUseServer.mockReturnValue({ servers: [] });

    renderAutomations('/automations?serverId=server-1');

    expect(lastQueryArgs()).toMatchObject({ serverId: 'server-1' });
  });

  it('reads the kind filter out of the URL and sends it to the query', () => {
    renderAutomations('/automations?kind=notification');

    expect(lastQueryArgs()).toMatchObject({ kind: 'notification' });
  });

  it('maps the status filter onto the enabled param', () => {
    renderAutomations('/automations?status=inactive');

    expect(lastQueryArgs()).toMatchObject({ enabled: false });
  });

  it('sends a header click as a server-side sort and returns to page one', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: /Kind/ }));

    expect(lastQueryArgs()).toMatchObject({ page: 1, orderBy: 'kind', orderDir: 'asc' });
  });

  it('offers four ready-made automations and three other ways in when the list is empty', () => {
    mockList([]);

    renderAutomations();

    expect(screen.getByText('No automations yet')).toBeInTheDocument();
    for (const name of [
      'Stream started',
      'Server down',
      'Too many streams at once',
      'Paused too long',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: `See all ${TEMPLATES.length}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paste a share code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start from scratch' })).toBeInTheDocument();
  });

  it('leaves the count off "See all" until the catalog has landed', () => {
    mockUseTemplates.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    mockList([]);

    renderAutomations();

    expect(screen.getByRole('button', { name: 'See all' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'See all 0' })).not.toBeInTheDocument();
  });

  it('opens one of the four straight into its binding form', async () => {
    const user = userEvent.setup();
    mockList([]);

    renderAutomations();

    await user.click(screen.getByRole('button', { name: /Stream started/ }));

    expect(await screen.findByRole('button', { name: 'Use this' })).toBeInTheDocument();
  });

  it('opens the gallery on a deep link and keeps the table underneath', () => {
    renderAutomations('/automations?template=template-concurrent-streams');

    expect(screen.getByRole('heading', { name: 'Too many streams at once' })).toBeInTheDocument();
  });

  it('blames the filters for an empty page when some are set', () => {
    mockList([]);

    renderAutomations('/automations?kind=policy');

    expect(screen.getByText('No automations found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your filters.')).toBeInTheDocument();
  });

  it('opens the automation when its row is clicked', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByText('Concurrent cap'));

    expect(openedDetail()).toBeInTheDocument();
  });

  it('toggles a row without navigating away from the list', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('switch'));

    expect(toggleMutate).toHaveBeenCalledWith({ id: 'a-1', isActive: false });
    expect(openedDetail()).not.toBeInTheDocument();
  });

  it('toggles a row from the keyboard without navigating away from the list', async () => {
    const user = userEvent.setup();
    renderAutomations();

    screen.getByRole('switch').focus();
    await user.keyboard('{Enter}');

    expect(toggleMutate).toHaveBeenCalledWith({ id: 'a-1', isActive: false });
    expect(openedDetail()).not.toBeInTheDocument();
  });

  it('sends the row edit action to the builder page rather than the automation', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(openedBuilder()).toBeInTheDocument();
    expect(openedDetail()).not.toBeInTheDocument();
  });

  it('offers no pencil on a row the builder would only bounce back', () => {
    mockList([
      automation({
        template: {
          id: 't-1',
          slug: 'stream-started',
          name: 'Stream started',
          version: 1,
          currentVersion: 1,
          source: 'builtin',
          author: null,
          addedAt: '2026-08-01T00:00:00.000Z',
        },
        templateInputs: { max: 4 },
      }),
    ]);
    renderAutomations();

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('opens the gallery from the header button rather than navigating', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: /New automation/ }));

    expect(await screen.findByRole('heading', { name: 'New automation' })).toBeInTheDocument();
    expect(openedBuilder()).not.toBeInTheDocument();
  });

  it('opens the paste box from the header, with no gallery behind it', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('heading', { name: 'Paste a share code' })).toBeInTheDocument();
    expect(screen.queryByText('Start from scratch')).not.toBeInTheDocument();
  });

  it('offers a share code for the row it was asked about', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByRole('heading', { name: 'Share this automation' })
    ).toBeInTheDocument();
  });

  it('asks for confirmation before deleting a single automation', async () => {
    const user = userEvent.setup();
    renderAutomations();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText(
        'Are you sure you want to delete this automation? This action cannot be undone.'
      )
    ).toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(openedDetail()).not.toBeInTheDocument();
  });
});
