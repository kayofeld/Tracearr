/** Real i18n: the update banner names a version number, which key-echoing hides. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { Automation, AutomationTemplateRef } from '@tracearr/shared';
import { CONCURRENT_STREAMS } from '@/components/automations/gallery/__tests__/fixtures';

vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/queries/useDestinations', () => ({ useDestinations: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));

const useTemplate = vi.fn();
const useTemplateVersion = vi.fn();
const rebind = vi.fn();
const upgrade = vi.fn();
const update = vi.fn();
const detach = vi.fn();

vi.mock('@/hooks/queries', () => ({
  useTemplate: () => useTemplate(),
  useTemplateVersion: () => useTemplateVersion(),
  useRebindAutomation: () => ({ mutateAsync: rebind, isPending: false }),
  useUpgradeAutomation: () => ({ mutateAsync: upgrade, isPending: false }),
  useUpdateAutomation: () => ({ mutateAsync: update, isPending: false }),
  useDetachAutomation: () => ({ mutate: detach, isPending: false }),
}));

import { AutomationDetailForm } from './AutomationDetailForm';

function renderForm(template: AutomationTemplateRef | null, row: Automation = automation) {
  render(
    <MemoryRouter>
      <AutomationDetailForm automation={row} template={template} />
    </MemoryRouter>
  );
  return userEvent.setup();
}

const template = (overrides: Partial<AutomationTemplateRef> = {}): AutomationTemplateRef => ({
  id: CONCURRENT_STREAMS.id,
  slug: CONCURRENT_STREAMS.slug,
  name: CONCURRENT_STREAMS.name,
  version: 1,
  currentVersion: 1,
  source: 'builtin',
  author: null,
  addedAt: '2026-08-01T12:00:00.000Z',
  ...overrides,
});

const automation: Automation = {
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
  templateInputs: { max: 4 },
  origin: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** The group the row's own limits live in, whichever kind of row is on the page. */
const thisAutomation = () => within(screen.getByRole('group', { name: 'This automation' }));

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

beforeEach(() => {
  vi.clearAllMocks();
  useTemplate.mockReturnValue({ data: CONCURRENT_STREAMS, isLoading: false });
  useTemplateVersion.mockReturnValue({ data: undefined });
  update.mockResolvedValue(automation);
  rebind.mockResolvedValue(automation);
  upgrade.mockResolvedValue(automation);
});

describe('AutomationDetailForm', () => {
  it('names the version the template has moved on to', () => {
    renderForm(template({ currentVersion: 4 }));

    expect(screen.getByText('The ready-made automation is now on v4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and update' })).toBeInTheDocument();
  });

  it('puts what it says now beside what it would say after', () => {
    useTemplateVersion.mockReturnValue({ data: CONCURRENT_STREAMS.version });

    renderForm(template({ currentVersion: 2 }));

    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.getByText('After the update')).toBeInTheDocument();
  });

  it('just saves when the row is already current', () => {
    renderForm(template());

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.queryByText('Now')).not.toBeInTheDocument();
  });

  it('names the row in the body, beside what it is for', () => {
    renderForm(template());

    expect(screen.getByLabelText('Name')).toHaveValue('Concurrent cap');
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it("puts the row's own limits in their own group, beside the blanks", () => {
    renderForm(template());

    expect(thisAutomation().getByLabelText('At most once every')).toBeInTheDocument();
    expect(thisAutomation().getByLabelText('Severity')).toBeInTheDocument();
    expect(thisAutomation().getByLabelText('Keep runs for')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'What it needs' })).toBeInTheDocument();
  });

  it('puts a blank label left of its control, which is the page shape', () => {
    renderForm(template());

    const row = screen.getByLabelText('Streams allowed').closest('[data-slot=field]');
    expect(row).toHaveAttribute('data-orientation', 'responsive');
  });

  it('marks the clause the answers wrote, and lights it while its field has focus', async () => {
    const user = renderForm(template());

    const clause = () => screen.getByText(/the stream count is above/);

    expect(clause()).toHaveClass('bg-primary/10');
    expect(clause()).not.toHaveClass('underline');

    await user.click(screen.getByLabelText('Streams allowed'));

    expect(clause()).toHaveClass('underline');
  });

  it('offers the builder beside the save', () => {
    renderForm(template());

    expect(screen.getByRole('button', { name: 'Open in the builder' })).toBeInTheDocument();
    expect(
      screen.getByText(/The steps come from the ready-made automation and are fixed/)
    ).toBeInTheDocument();
  });

  it('asks before the second door detaches the row', async () => {
    const user = renderForm(template());

    await user.click(screen.getByRole('button', { name: 'Open in the builder' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Open this in the builder?')).toBeInTheDocument();
    expect(detach).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'Open in the builder' }));

    expect(detach).toHaveBeenCalledWith('a-1', expect.anything());
  });

  it('says so when the template it followed is gone', () => {
    useTemplate.mockReturnValue({ data: undefined, isLoading: false });

    renderForm(template());

    expect(
      screen.getByText('The ready-made automation this was built from is no longer on this server.')
    ).toBeInTheDocument();
    // The name is the row's own, so a gone template never takes the rename away.
    expect(screen.getByLabelText('Name')).toHaveValue('Concurrent cap');
  });
});

describe('AutomationDetailForm one save', () => {
  it('leaves Save off until something has changed', () => {
    renderForm(template());

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it("sends only the row's own fields when only they changed", async () => {
    const user = renderForm(template());

    await user.type(screen.getByLabelText('Description'), 'Caps the household');

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith({
      id: 'a-1',
      silent: false,
      data: {
        name: 'Concurrent cap',
        description: 'Caps the household',
        severity: 'warning',
        cooldownMinutes: null,
        retentionDays: null,
      },
    });
    expect(rebind).not.toHaveBeenCalled();
  });

  it('sends only the answers when only they changed', async () => {
    const user = renderForm(template());

    await user.clear(screen.getByLabelText('Streams allowed'));
    await user.type(screen.getByLabelText('Streams allowed'), '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(rebind).toHaveBeenCalledWith({ id: 'a-1', inputs: { max: 6 } });
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the row's own fields before its answers, and says so once", async () => {
    const user = renderForm(template());

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Streams cap');
    await user.clear(screen.getByLabelText('Streams allowed'));
    await user.type(screen.getByLabelText('Streams allowed'), '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(Math.min(...rebind.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...update.mock.invocationCallOrder)
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
    expect(rebind).toHaveBeenCalledWith({ id: 'a-1', inputs: { max: 6 } });
  });

  it('never sends the answers after the first half was refused', async () => {
    update.mockRejectedValue(new Error('nope'));
    const user = renderForm(template());

    await user.type(screen.getByLabelText('Description'), 'Caps the household');
    await user.clear(screen.getByLabelText('Streams allowed'));
    await user.type(screen.getByLabelText('Streams allowed'), '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(rebind).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Description')).toHaveValue('Caps the household');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('stops claiming the fields that landed are unsaved when the answers are refused', async () => {
    rebind.mockRejectedValue(new Error('nope'));
    const user = renderForm(template());

    await user.type(screen.getByLabelText('Description'), 'Caps the household');
    await user.clear(screen.getByLabelText('Streams allowed'));
    await user.type(screen.getByLabelText('Streams allowed'), '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
    // The answers are still unsaved, so the row is still dirty and Save is still on.
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(rebind).toHaveBeenCalledTimes(2);
  });

  it('updates rather than rebinds when the template has moved on', async () => {
    const user = renderForm(template({ currentVersion: 2 }));

    await user.click(screen.getByRole('button', { name: 'Review and update' }));

    expect(upgrade).toHaveBeenCalledWith({ id: 'a-1', inputs: { max: 4 } });
    expect(rebind).not.toHaveBeenCalled();
  });

  it('refuses a nameless row rather than letting the API reject it', async () => {
    const user = renderForm(template());

    await user.clear(screen.getByLabelText('Name'));

    expect(screen.getByText('Give it a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('refuses a retention of zero and a cooldown that is not a number', async () => {
    const user = renderForm(template());

    await user.type(thisAutomation().getByLabelText('Keep runs for'), '0');
    expect(screen.getByText('Enter a whole number of days, at least 1, or leave it empty.'));

    await user.type(thisAutomation().getByLabelText('At most once every'), '10m');
    expect(
      screen.getByText('Enter a whole number of minutes, 0 or more, or leave it empty.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('takes a cooldown of zero, which its schema allows', async () => {
    const user = renderForm(template());

    await user.type(thisAutomation().getByLabelText('At most once every'), '0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cooldownMinutes: 0 }) })
    );
  });
});

describe('AutomationDetailForm without a template', () => {
  it('renders the same body without the blanks or the second door', () => {
    renderForm(null);

    expect(screen.getByLabelText('Name')).toHaveValue('Concurrent cap');
    expect(thisAutomation().getByLabelText('Keep runs for')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'What this will do' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What it needs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in the builder' })).not.toBeInTheDocument();
  });

  it("saves the row's own fields from the same doors row", async () => {
    const user = renderForm(null);

    await user.type(thisAutomation().getByLabelText('Keep runs for'), '90');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ retentionDays: 90 }) })
    );
    expect(rebind).not.toHaveBeenCalled();
  });

  it('leaves severity off a notification row, which triages nothing', () => {
    renderForm(null, { ...automation, kind: 'notification', severity: null });

    expect(thisAutomation().queryByLabelText('Severity')).not.toBeInTheDocument();
  });
});
