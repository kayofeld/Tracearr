import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    api: { automations: { export: vi.fn() }, templates: { create: vi.fn() } },
    ApiError,
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ servers: [{ id: 'server-1', name: 'Beehive' }] }),
}));
vi.mock('@/hooks/queries/useDestinations', () => ({ useDestinations: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { ExportDialog } from '../ExportDialog';
import { previewOf, renderSharing, SHARE_CODE, SHARED_ENVELOPE } from './fixtures';

const exported = vi.mocked(api.automations.export);
const create = vi.mocked(api.templates.create);

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const automation = { id: 'automation-1', name: 'Two places at once — Beehive' };

beforeEach(() => {
  vi.clearAllMocks();
  exported.mockResolvedValue({ envelope: SHARED_ENVELOPE, code: SHARE_CODE });
  create.mockResolvedValue(previewOf().envelope as never);
});

function renderDialog() {
  return renderSharing(<ExportDialog automation={automation} open onOpenChange={vi.fn()} />);
}

describe('ExportDialog', () => {
  it('shows the one line to send, and copies it', async () => {
    const { user } = renderDialog();

    expect(await screen.findByText(SHARE_CODE)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy the share code' }));

    await expect(navigator.clipboard.readText()).resolves.toBe(SHARE_CODE);
  });

  it('leads with the code, with no tab strip and no second way to the json', async () => {
    renderDialog();

    await screen.findByText(SHARE_CODE);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the JSON' })).not.toBeInTheDocument();
    expect(screen.queryByText(/"slug": "two-places-at-once"/)).not.toBeInTheDocument();
  });

  it('offers one way out, so nothing is named Close twice', async () => {
    renderDialog();

    await screen.findByText(SHARE_CODE);

    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('says what the code leaves behind', async () => {
    renderDialog();

    expect(
      await screen.findByText(/Destinations, servers and accounts are not included/)
    ).toBeInTheDocument();
  });

  it('gives saving a copy its own row, so the footer holds one button', async () => {
    renderDialog();

    await screen.findByText(SHARE_CODE);

    expect(
      screen.getByText("Adds it to this server's list of ready-made automations.")
    ).toBeInTheDocument();
  });

  it('keeps the author name and the json inside the gallery section', async () => {
    const { user } = renderDialog();

    await screen.findByText(SHARE_CODE);

    expect(screen.queryByLabelText('Author')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Put this in the community gallery' }));

    expect(screen.getByLabelText('Author')).toBeInTheDocument();
    expect(screen.getByLabelText('Section')).toBeInTheDocument();
    // The envelope is offered from one place, next to the words about the pull request.
    expect(screen.getByText(/"slug": "two-places-at-once"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy the JSON' }));
    await expect(navigator.clipboard.readText()).resolves.toContain('"two-places-at-once"');
    expect(screen.getByRole('link', { name: /Open the gallery/ })).toHaveAttribute(
      'href',
      'https://docs.tracearr.com/templates'
    );
    expect(screen.getByRole('link', { name: /Open the repository/ })).toHaveAttribute(
      'href',
      'https://github.com/Tracearr/automation-templates'
    );
  });

  it('asks the server again once a name is typed, and says so under the code', async () => {
    const { user } = renderDialog();

    await screen.findByText(SHARE_CODE);
    await user.click(screen.getByRole('button', { name: 'Put this in the community gallery' }));

    expect(screen.queryByText('The code includes the author name.')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Author'), 'Ada');

    await waitFor(() => expect(exported).toHaveBeenCalledWith('automation-1', 'Ada', undefined));
    // Under the code it is about, so collapsing the gallery section does not hide it.
    await user.click(screen.getByRole('button', { name: 'Put this in the community gallery' }));
    expect(await screen.findByText('The code includes the author name.')).toBeInTheDocument();
  });

  it('saves the same envelope into the library as one of your own', async () => {
    const { user } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Save as ready-made' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ envelope: SHARED_ENVELOPE, source: 'local' })
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('says so when the automation cannot be turned into a code', async () => {
    exported.mockRejectedValue(new Error('This automation cannot be exported'));
    renderDialog();

    expect(await screen.findByText("Couldn't make a code for this one.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as ready-made' })).not.toBeInTheDocument();
  });
});
