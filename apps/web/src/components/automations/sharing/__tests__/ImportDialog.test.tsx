import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    api: { templates: { preview: vi.fn(), create: vi.fn(), instantiate: vi.fn() } },
    ApiError,
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));
vi.mock('@/hooks/queries/useDestinations', () => ({ useDestinations: () => ({ data: [] }) }));

vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: () => null,
}));

import { api } from '@/lib/api';
import { ImportDialog } from '../ImportDialog';
import { previewOf, renderSharing, SHARE_CODE, SHARED_ENVELOPE } from './fixtures';

const preview = vi.mocked(api.templates.preview);

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(previewOf());
});

function renderDialog() {
  const onOpenChange = vi.fn();
  const { user } = renderSharing(<ImportDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user };
}

/** The list page keeps this dialog mounted and owns the open flag; so does this. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Import
      </button>
      <ImportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

const box = () => screen.getByRole('textbox', { name: 'Paste a share code' });

async function check(user: ReturnType<typeof renderDialog>['user']) {
  await user.type(box(), SHARE_CODE);
  await user.click(screen.getByRole('button', { name: 'Check it' }));
}

describe('ImportDialog', () => {
  it('opens on the box, with nothing read yet', () => {
    renderDialog();

    expect(screen.getByRole('heading', { name: 'Paste a share code' })).toBeInTheDocument();
    expect(box()).toBeInTheDocument();
  });

  it('titles the review with the name the code carries, and describes the view it is', async () => {
    const { user } = renderDialog();

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Paste the code. Everything is in the code; Tracearr fetches nothing.'
    );

    await check(user);

    expect(await screen.findByRole('heading', { name: 'Two places at once' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'What the code does, and what to fill in.'
    );
  });

  it('renders a name that looks like markup as the text it is', async () => {
    preview.mockResolvedValue(
      previewOf({ envelope: { ...SHARED_ENVELOPE, name: '<img src=x onerror=alert(1)>' } })
    );
    const { user } = renderDialog();

    await check(user);

    expect(
      await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' })
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('steps Esc back to the box before it closes anything', async () => {
    const { onOpenChange, user } = renderDialog();

    await check(user);
    await screen.findByRole('heading', { name: 'Two places at once' });

    await user.keyboard('{Escape}');

    expect(box()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('forgets a finished review, so the next press opens the box again', async () => {
    const { user } = renderSharing(<Host />);

    await user.click(screen.getByRole('button', { name: 'Import' }));
    await check(user);
    await screen.findByRole('heading', { name: 'Two places at once' });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('heading', { name: 'Paste a share code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add it' })).not.toBeInTheDocument();
  });

  it('closes from the box, which is as far back as it goes', async () => {
    const { onOpenChange, user } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
