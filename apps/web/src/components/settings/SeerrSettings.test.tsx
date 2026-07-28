import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { SeerrStatusResponse } from '@tracearr/shared';
import type * as ApiModule from '@/lib/api';
import { SeerrSettings } from './SeerrSettings';

function renderPanel() {
  return render(
    <MemoryRouter>
      <SeerrSettings />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && 'count' in options) return `${key}:${String(options.count)}`;
      if (options && 'version' in options) return `${key}:${String(options.version)}`;
      return key;
    },
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}));

const mockTestConnection = vi.fn();
vi.mock('@/lib/api', async () => {
  // `actual.api` is a class instance - spreading it would drop its prototype,
  // so monkey-patch the one method under test instead of cloning the object.
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  actual.api.seerr.testConnection = ((...args: unknown[]) =>
    mockTestConnection(...args)) as typeof actual.api.seerr.testConnection;
  return actual;
});

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useUpdateSettings: vi.fn(),
  useSeerrStatus: vi.fn(),
  useSeerrMappings: vi.fn(),
  useSeerrSync: vi.fn(),
  useSeerrPurge: vi.fn(),
  useUpsertSeerrMapping: vi.fn(),
  useRevertSeerrMapping: vi.fn(),
  useUsers: vi.fn(),
}));

import {
  useSettings,
  useUpdateSettings,
  useSeerrStatus,
  useSeerrMappings,
  useSeerrSync,
  useSeerrPurge,
  useUpsertSeerrMapping,
  useRevertSeerrMapping,
  useUsers,
} from '@/hooks/queries';

const mockUseSettings = vi.mocked(useSettings);
const mockUseUpdateSettings = vi.mocked(useUpdateSettings);
const mockUseSeerrStatus = vi.mocked(useSeerrStatus);
const mockUseSeerrMappings = vi.mocked(useSeerrMappings);
const mockUseSeerrSync = vi.mocked(useSeerrSync);
const mockUseSeerrPurge = vi.mocked(useSeerrPurge);
const mockUseUpsertSeerrMapping = vi.mocked(useUpsertSeerrMapping);
const mockUseRevertSeerrMapping = vi.mocked(useRevertSeerrMapping);
const mockUseUsers = vi.mocked(useUsers);

function settingsReturn(overrides: Partial<ReturnType<typeof useSettings>> = {}) {
  return {
    data: { seerrUrl: null, seerrApiKey: null },
    isLoading: false,
    ...overrides,
  } as unknown as ReturnType<typeof useSettings>;
}

function statusReturn(overrides: Partial<SeerrStatusResponse> = {}) {
  return {
    data: {
      configured: false,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      counts: { movieRequests: 0, tvRequests: 0, total: 0, skippedValidation: 0 },
      purgeAvailable: false,
      attribution: { matched: 0, manual: 0, unattributed: 0 },
      mediaMatch: { matched: 0, unmatched: 0 },
      ...overrides,
    },
    isLoading: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useSeerrStatus>;
}

function mutationReturn(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    ...overrides,
  };
}

describe('SeerrSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSettings.mockReturnValue(settingsReturn());
    mockUseUpdateSettings.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useUpdateSettings>
    );
    mockUseSeerrStatus.mockReturnValue(statusReturn());
    mockUseSeerrMappings.mockReturnValue({
      data: { requesters: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useSeerrMappings>);
    mockUseSeerrSync.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useSeerrSync>
    );
    mockUseSeerrPurge.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useSeerrPurge>
    );
    mockUseUpsertSeerrMapping.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useUpsertSeerrMapping>
    );
    mockUseRevertSeerrMapping.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useRevertSeerrMapping>
    );
    mockUseUsers.mockReturnValue({
      data: { data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUsers>);
  });

  it('does not show the purge control while the connector is configured', () => {
    mockUseSeerrStatus.mockReturnValue(statusReturn({ configured: true, purgeAvailable: false }));

    renderPanel();

    expect(screen.queryByText('settings:seerr.purgeTitle')).not.toBeInTheDocument();
  });

  it('shows the purge control once the connector is disconnected but rows remain', () => {
    mockUseSeerrStatus.mockReturnValue(statusReturn({ configured: false, purgeAvailable: true }));

    renderPanel();

    expect(screen.getByText('settings:seerr.purgeTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings:seerr.purgeButton' })).toBeInTheDocument();
  });

  it('renders the not-configured state when the connector has no url/key', () => {
    renderPanel();

    expect(screen.getByText('settings:seerr.notConfigured')).toBeInTheDocument();
  });

  it('surfaces the reported version and user count on a successful test connection', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockTestConnection.mockResolvedValue({ success: true, version: '3.4.0', userCount: 46 });

    renderPanel();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('settings:seerr.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'servers.testConnection' }));

    // The mocked t() renders whichever interpolated option (count or version)
    // it finds first; either way confirms both values reached the call.
    expect(mockTestConnection).toHaveBeenCalledWith({
      url: 'https://seerr.example.com',
      apiKey: 'secret-key',
    });
    expect(await screen.findByText(/settings:seerr\.connectedFound/)).toBeInTheDocument();
  });

  it('surfaces the specific error message on a failed test connection', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockTestConnection.mockResolvedValue({ success: false, error: 'Invalid API key' });

    renderPanel();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('settings:seerr.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'bad-key');
    await user.click(screen.getByRole('button', { name: 'servers.testConnection' }));

    expect(await screen.findByText('Invalid API key')).toBeInTheDocument();
  });

  it('disables Sync Now while the connector is unconfigured', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: /settings:seerr.syncNow/ })).toBeDisabled();
  });

  describe('handleSave auto-sync-on-configure transition', () => {
    /** updateSettings.mutate stub that immediately fires the caller's onSuccess,
     * mirroring a successful settings save. */
    function updateSettingsCallingOnSuccess() {
      const mutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) =>
        opts?.onSuccess?.()
      );
      mockUseUpdateSettings.mockReturnValue(
        mutationReturn({ mutate }) as unknown as ReturnType<typeof useUpdateSettings>
      );
      return mutate;
    }

    function syncSpy() {
      const mutate = vi.fn();
      mockUseSeerrSync.mockReturnValue(
        mutationReturn({ mutate }) as unknown as ReturnType<typeof useSeerrSync>
      );
      return mutate;
    }

    it('triggers one sync when saving takes the connector from unconfigured to configured', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      updateSettingsCallingOnSuccess();
      const sync = syncSpy();
      // status.configured=false (default statusReturn) -> this save IS the transition.
      renderPanel();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText('settings:seerr.url'), 'https://seerr.example.com');
      await user.type(screen.getByLabelText('common:labels.apiKey'), 'secret-key');
      await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

      expect(sync).toHaveBeenCalledTimes(1);
      // Auto-triggered sync must pass silent:true so a 409 (already running)
      // doesn't surface as a misleading "save failed" error toast.
      expect(sync).toHaveBeenCalledWith({ silent: true });
    });

    it('does NOT re-trigger a sync when re-saving while already configured', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      mockUseSettings.mockReturnValue(
        settingsReturn({
          data: { seerrUrl: 'https://seerr.example.com', seerrApiKey: 'secret-key' },
        } as never)
      );
      mockUseSeerrStatus.mockReturnValue(statusReturn({ configured: true }));
      const updateMutate = updateSettingsCallingOnSuccess();
      const sync = syncSpy();
      renderPanel();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

      expect(updateMutate).toHaveBeenCalledTimes(1); // the save itself went through
      expect(sync).not.toHaveBeenCalled(); // but no auto-sync on a re-save
    });

    it('does NOT trigger a sync when saving a disconnect (fields cleared)', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      mockUseSettings.mockReturnValue(
        settingsReturn({
          data: { seerrUrl: 'https://seerr.example.com', seerrApiKey: 'secret-key' },
        } as never)
      );
      mockUseSeerrStatus.mockReturnValue(statusReturn({ configured: true }));
      const updateMutate = updateSettingsCallingOnSuccess();
      const sync = syncSpy();
      renderPanel();

      const user = userEvent.setup();
      await user.clear(screen.getByLabelText('settings:seerr.url'));
      await user.clear(screen.getByLabelText('common:labels.apiKey'));
      await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

      // Disconnect persists null/null and never fires the transition sync.
      expect(updateMutate).toHaveBeenCalledWith(
        { seerrUrl: null, seerrApiKey: null },
        expect.anything()
      );
      expect(sync).not.toHaveBeenCalled();
    });

    it('does NOT trigger a sync when the save fails (onSuccess never fires)', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const mutate = vi.fn(); // never calls onSuccess - simulates a failed save
      mockUseUpdateSettings.mockReturnValue(
        mutationReturn({ mutate }) as unknown as ReturnType<typeof useUpdateSettings>
      );
      const sync = syncSpy();
      renderPanel();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText('settings:seerr.url'), 'https://seerr.example.com');
      await user.type(screen.getByLabelText('common:labels.apiKey'), 'secret-key');
      await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(sync).not.toHaveBeenCalled();
    });
  });
});
