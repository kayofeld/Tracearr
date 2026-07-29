import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { VersionInfo, VersionUpdateCapability } from '@tracearr/shared';
import type * as ApiModule from '@/lib/api';
import { UpdateDialog, DOCKER_UPDATE_POLL_MAX_ATTEMPTS } from './UpdateDialog';
import { api } from '@/lib/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && 'version' in options) return `${key}:${String(options.version)}`;
      return key;
    },
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useUpdateCapability: vi.fn(),
}));

const { mockVersionGet, mockVersionUpdate, mockVersionUpdateStatus } = vi.hoisted(() => ({
  mockVersionGet: vi.fn(),
  mockVersionUpdate: vi.fn(),
  mockVersionUpdateStatus: vi.fn(),
}));
vi.mock('@/lib/api', async () => {
  // `actual.api` is a class instance - spreading it would drop its prototype
  // (mirrors the same fix used in OmbiSettings.test.tsx), so monkey-patch the
  // three methods under test instead of cloning the object.
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  actual.api.version.get = mockVersionGet as typeof actual.api.version.get;
  actual.api.version.update = mockVersionUpdate as typeof actual.api.version.update;
  actual.api.version.updateStatus =
    mockVersionUpdateStatus as typeof actual.api.version.updateStatus;
  return actual;
});

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { useUpdateCapability } from '@/hooks/queries';
const mockUseUpdateCapability = vi.mocked(useUpdateCapability);

function capability(overrides: Partial<VersionUpdateCapability> = {}) {
  return {
    data: {
      available: false,
      enabled: false,
      isDocker: false,
      dockerRedeployConfigured: false,
      dockerNote: null,
      ...overrides,
    },
    isLoading: false,
  } as unknown as ReturnType<typeof useUpdateCapability>;
}

function version(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: {
      version: '1.0.0',
      tag: 'v1.0.0',
      commit: null,
      buildDate: null,
      isPrerelease: false,
    },
    latest: {
      version: '2.0.0',
      tag: 'v2.0.0',
      releaseUrl: 'https://example.com/releases/2.0.0',
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      releaseName: null,
      releaseNotes: null,
    },
    updateAvailable: true,
    lastChecked: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderDialog(v: VersionInfo = version()) {
  return render(
    <MemoryRouter>
      <UpdateDialog open onOpenChange={vi.fn()} version={v} />
    </MemoryRouter>
  );
}

describe('UpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUseUpdateCapability.mockReturnValue(capability());
    vi.mocked(api.version.get).mockResolvedValue(version());
    vi.mocked(api.version.updateStatus).mockResolvedValue({
      state: 'idle',
      message: null,
      at: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the manual docker/pull command and no update button when self-update is unavailable', () => {
    renderDialog();

    expect(screen.getByText('settings:update.updateCommand')).toBeInTheDocument();
    expect(screen.queryByText('settings:update.updateNow')).not.toBeInTheDocument();
  });

  it('Docker + configured: links to the Updates settings tab with the not-configured docker note when unavailable', () => {
    mockUseUpdateCapability.mockReturnValue(
      capability({ isDocker: true, dockerNote: 'Configure a webhook to enable updates.' })
    );

    renderDialog();

    expect(screen.getByText(/Configure a webhook to enable updates\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'settings:tabs.updates' })).toHaveAttribute(
      'href',
      '/settings/updates'
    );
  });

  it('Docker + configured: triggering the update shows the backend-supplied note, not a generic spinner message', async () => {
    mockUseUpdateCapability.mockReturnValue(
      capability({ available: true, isDocker: true, dockerRedeployConfigured: true })
    );
    vi.mocked(api.version.update).mockResolvedValue({
      started: true,
      target: '2.0.0',
      note: 'Redeploy triggered. Check Portainer for status.',
    });

    renderDialog();

    await act(async () => {
      screen.getByRole('button', { name: 'settings:update.updateNow' }).click();
      await Promise.resolve();
    });

    expect(screen.getByText('Redeploy triggered. Check Portainer for status.')).toBeInTheDocument();
  });

  it('Docker: a network failure on trigger does NOT surface an error toast (expected mid-redeploy)', async () => {
    mockUseUpdateCapability.mockReturnValue(
      capability({ available: true, isDocker: true, dockerRedeployConfigured: true })
    );
    vi.mocked(api.version.update).mockRejectedValue(new Error('Failed to fetch'));

    renderDialog();

    await act(async () => {
      screen.getByRole('button', { name: 'settings:update.updateNow' }).click();
      await Promise.resolve();
    });

    expect(toastError).not.toHaveBeenCalled();
    // Still shows the "in progress"/waiting UI, not a stuck error state.
    expect(screen.getByRole('button', { name: 'settings:update.updateNow' })).toBeDisabled();
  });

  it('Docker: detects the version bump and reloads, without ever reading the bare-metal status file as a failure', async () => {
    mockUseUpdateCapability.mockReturnValue(
      capability({ available: true, isDocker: true, dockerRedeployConfigured: true })
    );
    vi.mocked(api.version.update).mockResolvedValue({ started: true, target: '2.0.0' });
    // Docker never has a real status file - server reports 'unknown'.
    vi.mocked(api.version.updateStatus).mockResolvedValue({
      state: 'unknown',
      message: 'Docker deployments cannot report update progress from inside the container.',
      at: null,
    });
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });

    renderDialog();

    await act(async () => {
      screen.getByRole('button', { name: 'settings:update.updateNow' }).click();
      await Promise.resolve();
    });

    // The version check now reports the bump - the very next poll tick
    // should detect it and stop, regardless of the 'unknown' status state.
    vi.mocked(api.version.get).mockResolvedValue(
      version({
        current: {
          version: '2.0.0',
          tag: 'v2.0.0',
          commit: null,
          buildDate: null,
          isPrerelease: false,
        },
      })
    );

    // The version bump stops the poll and schedules a reload - it must not
    // keep waiting on the Docker 'unknown' status state once the version
    // itself confirms the redeploy landed. First poll tick at +3000ms, then
    // the reload fires 1500ms after that.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(reloadSpy).toHaveBeenCalled();
    // Not stuck on the "waiting to restart" / timed-out states.
    expect(screen.queryByText('settings:update.dockerTimedOut')).not.toBeInTheDocument();
  });

  it('Docker: gives up after the poll bound and shows an honest terminal state instead of spinning forever', async () => {
    mockUseUpdateCapability.mockReturnValue(
      capability({ available: true, isDocker: true, dockerRedeployConfigured: true })
    );
    vi.mocked(api.version.update).mockResolvedValue({ started: true, target: '2.0.0' });
    // Version never changes and status stays 'unknown' - simulates a redeploy
    // that never lands (or this tab never regains connectivity).
    vi.mocked(api.version.get).mockResolvedValue(version());
    vi.mocked(api.version.updateStatus).mockResolvedValue({
      state: 'unknown',
      message: null,
      at: null,
    });

    renderDialog();

    await act(async () => {
      screen.getByRole('button', { name: 'settings:update.updateNow' }).click();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * DOCKER_UPDATE_POLL_MAX_ATTEMPTS);
    });

    expect(screen.getByText('settings:update.dockerTimedOut')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /common:actions.refresh/ })).toBeInTheDocument();
    // Not stuck spinning - the update button is re-enabled.
    expect(screen.getByRole('button', { name: 'settings:update.updateNow' })).toBeEnabled();
  });

  it('Bare metal: a failed status poll still surfaces an error toast (regression)', async () => {
    mockUseUpdateCapability.mockReturnValue(capability({ available: true, isDocker: false }));
    vi.mocked(api.version.update).mockResolvedValue({ started: true, target: '2.0.0' });
    vi.mocked(api.version.get).mockResolvedValue(version());
    vi.mocked(api.version.updateStatus).mockResolvedValue({
      state: 'failed',
      message: 'Build failed',
      at: null,
    });

    renderDialog();

    await act(async () => {
      screen.getByRole('button', { name: 'settings:update.updateNow' }).click();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(toastError).toHaveBeenCalledWith('Build failed');
  });
});
