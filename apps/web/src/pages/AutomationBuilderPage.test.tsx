import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Automation, AutomationTemplateRef } from '@tracearr/shared';
import type { AutomationDraft } from '@/lib/automations';
import { AutomationBuilderPage } from './AutomationBuilderPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

vi.mock('@/components/automations/builder', () => ({
  AutomationBuilder: ({ draft }: { draft?: AutomationDraft }) => (
    <p>{draft ? `the builder · ${draft.name}` : 'the builder'}</p>
  ),
}));

vi.mock('@/hooks/queries/useAutomations', () => ({ useAutomation: vi.fn() }));

import { toast } from 'sonner';
import { useAutomation } from '@/hooks/queries/useAutomations';

const mockUseAutomation = vi.mocked(useAutomation);

const template: AutomationTemplateRef = {
  id: 't-1',
  slug: 'concurrent-streams',
  name: 'Too many streams at once',
  version: 1,
  currentVersion: 1,
  source: 'builtin',
  author: null,
  addedAt: '2026-08-01T00:00:00.000Z',
};

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Concurrent cap',
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [],
    conditions: { groups: [] },
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

const draft = {
  name: 'Stream started — Beehive',
  description: null,
  kind: 'notification',
  severity: null,
  isActive: true,
  triggers: [],
  conditions: { groups: [] },
  actions: { actions: [] },
  serverId: null,
  serverUserId: null,
  userId: null,
  enforceAcrossServers: false,
} satisfies AutomationDraft;

function renderPage(
  entry: string | { pathname: string; state: unknown } = '/automations/a-1/edit'
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/automations/new" element={<AutomationBuilderPage />} />
        <Route path="/automations/:id/edit" element={<AutomationBuilderPage />} />
        <Route path="/automations/:id" element={<p>the detail page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AutomationBuilderPage', () => {
  it('opens the builder on a row that owns its own steps', () => {
    mockUseAutomation.mockReturnValue({
      data: automation(),
      isLoading: false,
    } as unknown as ReturnType<typeof useAutomation>);

    renderPage();

    expect(screen.getByText('the builder')).toBeInTheDocument();
  });

  it('opens on the answers a ready-made automation carried over', () => {
    mockUseAutomation.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useAutomation>);

    renderPage({ pathname: '/automations/new', state: { draft } });

    expect(screen.getByText('the builder · Stream started — Beehive')).toBeInTheDocument();
  });

  it('ignores a carried draft on an edit route', () => {
    mockUseAutomation.mockReturnValue({
      data: automation(),
      isLoading: false,
    } as unknown as ReturnType<typeof useAutomation>);

    renderPage({ pathname: '/automations/a-1/edit', state: { draft } });

    expect(screen.getByText('the builder')).toBeInTheDocument();
  });

  it('sends a template-bound row back to its detail page instead', () => {
    mockUseAutomation.mockReturnValue({
      data: automation({ template }),
      isLoading: false,
    } as unknown as ReturnType<typeof useAutomation>);

    renderPage();

    expect(screen.getByText('the detail page')).toBeInTheDocument();
    expect(screen.queryByText('the builder')).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith('automations.template.customizeFirst');
  });
});
