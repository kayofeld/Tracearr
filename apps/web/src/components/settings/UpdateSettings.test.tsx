import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { VersionUpdateCapability } from '@tracearr/shared';
import { UpdateSettings } from './UpdateSettings';

function renderPanel() {
  return render(
    <MemoryRouter>
      <UpdateSettings />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useUpdateCapability: vi.fn(),
  useSetDockerRedeployWebhook: vi.fn(),
  useClearDockerRedeployWebhook: vi.fn(),
}));

import {
  useUpdateCapability,
  useSetDockerRedeployWebhook,
  useClearDockerRedeployWebhook,
} from '@/hooks/queries';

const mockUseUpdateCapability = vi.mocked(useUpdateCapability);
const mockUseSetWebhook = vi.mocked(useSetDockerRedeployWebhook);
const mockUseClearWebhook = vi.mocked(useClearDockerRedeployWebhook);

function capabilityReturn(overrides: Partial<VersionUpdateCapability> = {}) {
  return {
    data: {
      available: false,
      enabled: false,
      isDocker: true,
      dockerRedeployConfigured: false,
      dockerNote:
        'Configure a Portainer stack redeploy webhook in Settings to enable in-app updates.',
      ...overrides,
    },
    isLoading: false,
  } as unknown as ReturnType<typeof useUpdateCapability>;
}

function mutationReturn(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    ...overrides,
  };
}

describe('UpdateSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUpdateCapability.mockReturnValue(capabilityReturn());
    mockUseSetWebhook.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useSetDockerRedeployWebhook>
    );
    mockUseClearWebhook.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useClearDockerRedeployWebhook>
    );
  });

  it('hides the Portainer webhook field entirely on a bare-metal deployment', () => {
    mockUseUpdateCapability.mockReturnValue(capabilityReturn({ isDocker: false }));

    renderPanel();

    expect(screen.queryByLabelText('settings:dockerUpdate.webhookUrl')).not.toBeInTheDocument();
    expect(screen.getByText('settings:dockerUpdate.bareMetalDescription')).toBeInTheDocument();
  });

  it('shows the webhook field and "Not configured" badge on Docker when unconfigured', () => {
    renderPanel();

    expect(screen.getByLabelText('settings:dockerUpdate.webhookUrl')).toBeInTheDocument();
    expect(screen.getByText('settings:dockerUpdate.notConfigured')).toBeInTheDocument();
    expect(screen.queryByText('settings:dockerUpdate.configured')).not.toBeInTheDocument();
  });

  it('shows "Configured" and a Remove button once a webhook is set, without ever pre-filling the URL', () => {
    mockUseUpdateCapability.mockReturnValue(
      capabilityReturn({
        available: true,
        dockerRedeployConfigured: true,
        dockerNote:
          'Redeploying only changes the running version if your compose file tracks a moving tag.',
      })
    );

    renderPanel();

    expect(screen.getByText('settings:dockerUpdate.configured')).toBeInTheDocument();
    // Write-only: the server never returns the URL, so the input must start
    // empty even though the webhook IS configured server-side.
    expect(screen.getByLabelText('settings:dockerUpdate.webhookUrl')).toHaveValue('');
    expect(screen.getByRole('button', { name: /common:actions.remove/ })).toBeInTheDocument();
  });

  it('renders the server-supplied caveat note verbatim', () => {
    mockUseUpdateCapability.mockReturnValue(
      capabilityReturn({ dockerNote: 'A pinned exact version tag will redeploy unchanged.' })
    );

    renderPanel();

    expect(
      screen.getByText('A pinned exact version tag will redeploy unchanged.')
    ).toBeInTheDocument();
  });

  it('disables Save until a URL is entered, then saves and clears the input', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const mutate = vi.fn((_url: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockUseSetWebhook.mockReturnValue(
      mutationReturn({ mutate }) as unknown as ReturnType<typeof useSetDockerRedeployWebhook>
    );

    renderPanel();

    const saveButton = screen.getByRole('button', { name: 'common:actions.save' });
    expect(saveButton).toBeDisabled();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('settings:dockerUpdate.webhookUrl'),
      'https://portainer.example.com/api/webhooks/abc123'
    );
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    expect(mutate).toHaveBeenCalledWith(
      'https://portainer.example.com/api/webhooks/abc123',
      expect.anything()
    );
    expect(screen.getByLabelText('settings:dockerUpdate.webhookUrl')).toHaveValue('');
  });

  it('clears the webhook through the confirm dialog', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockUseUpdateCapability.mockReturnValue(
      capabilityReturn({ available: true, dockerRedeployConfigured: true })
    );
    const mutate = vi.fn();
    mockUseClearWebhook.mockReturnValue(
      mutationReturn({ mutate }) as unknown as ReturnType<typeof useClearDockerRedeployWebhook>
    );

    renderPanel();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /common:actions.remove/ }));
    // Confirm dialog title appears
    expect(screen.getByText('settings:dockerUpdate.clearConfirmTitle')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'settings:dockerUpdate.clearConfirmAction' })
    );

    expect(mutate).toHaveBeenCalled();
  });
});
