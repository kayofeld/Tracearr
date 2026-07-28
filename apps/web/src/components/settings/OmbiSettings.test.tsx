import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { OmbiStatusResponse } from '@tracearr/shared';
import type * as ApiModule from '@/lib/api';
import { OmbiSettings } from './OmbiSettings';

function renderPanel() {
  return render(
    <MemoryRouter>
      <OmbiSettings />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && 'count' in options) return `${key}:${String(options.count)}`;
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
  actual.api.ombi.testConnection = ((...args: unknown[]) =>
    mockTestConnection(...args)) as typeof actual.api.ombi.testConnection;
  return actual;
});

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useUpdateSettings: vi.fn(),
  useOmbiStatus: vi.fn(),
  useOmbiMappings: vi.fn(),
  useOmbiSync: vi.fn(),
  useOmbiPurge: vi.fn(),
  useUpsertOmbiMapping: vi.fn(),
  useRevertOmbiMapping: vi.fn(),
  useUsers: vi.fn(),
}));

import {
  useSettings,
  useUpdateSettings,
  useOmbiStatus,
  useOmbiMappings,
  useOmbiSync,
  useOmbiPurge,
  useUpsertOmbiMapping,
  useRevertOmbiMapping,
  useUsers,
} from '@/hooks/queries';

const mockUseSettings = vi.mocked(useSettings);
const mockUseUpdateSettings = vi.mocked(useUpdateSettings);
const mockUseOmbiStatus = vi.mocked(useOmbiStatus);
const mockUseOmbiMappings = vi.mocked(useOmbiMappings);
const mockUseOmbiSync = vi.mocked(useOmbiSync);
const mockUseOmbiPurge = vi.mocked(useOmbiPurge);
const mockUseUpsertOmbiMapping = vi.mocked(useUpsertOmbiMapping);
const mockUseRevertOmbiMapping = vi.mocked(useRevertOmbiMapping);
const mockUseUsers = vi.mocked(useUsers);

function settingsReturn(overrides: Partial<ReturnType<typeof useSettings>> = {}) {
  return {
    data: { ombiUrl: null, ombiApiKey: null },
    isLoading: false,
    ...overrides,
  } as unknown as ReturnType<typeof useSettings>;
}

function statusReturn(overrides: Partial<OmbiStatusResponse> = {}) {
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
  } as unknown as ReturnType<typeof useOmbiStatus>;
}

function mutationReturn(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    ...overrides,
  };
}

describe('OmbiSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSettings.mockReturnValue(settingsReturn());
    mockUseUpdateSettings.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useUpdateSettings>
    );
    mockUseOmbiStatus.mockReturnValue(statusReturn());
    mockUseOmbiMappings.mockReturnValue({
      data: { requesters: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useOmbiMappings>);
    mockUseOmbiSync.mockReturnValue(mutationReturn() as unknown as ReturnType<typeof useOmbiSync>);
    mockUseOmbiPurge.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useOmbiPurge>
    );
    mockUseUpsertOmbiMapping.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useUpsertOmbiMapping>
    );
    mockUseRevertOmbiMapping.mockReturnValue(
      mutationReturn() as unknown as ReturnType<typeof useRevertOmbiMapping>
    );
    mockUseUsers.mockReturnValue({
      data: { data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUsers>);
  });

  it('does not show the purge control while the connector is configured', () => {
    mockUseOmbiStatus.mockReturnValue(statusReturn({ configured: true, purgeAvailable: false }));

    renderPanel();

    expect(screen.queryByText('settings:ombi.purgeTitle')).not.toBeInTheDocument();
  });

  it('shows the purge control once the connector is disconnected but rows remain', () => {
    mockUseOmbiStatus.mockReturnValue(statusReturn({ configured: false, purgeAvailable: true }));

    renderPanel();

    expect(screen.getByText('settings:ombi.purgeTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings:ombi.purgeButton' })).toBeInTheDocument();
  });

  it('renders the not-configured state when the connector has no url/key', () => {
    renderPanel();

    expect(screen.getByText('settings:ombi.notConfigured')).toBeInTheDocument();
  });

  it('surfaces the reported user count on a successful test connection', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockTestConnection.mockResolvedValue({ success: true, userCount: 12 });

    renderPanel();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('settings:ombi.url'), 'http://localhost:5000');
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'servers.testConnection' }));

    expect(await screen.findByText('settings:ombi.connectedFound:12')).toBeInTheDocument();
    expect(mockTestConnection).toHaveBeenCalledWith({
      url: 'http://localhost:5000',
      apiKey: 'secret-key',
    });
  });

  it('surfaces the specific error message on a failed test connection', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockTestConnection.mockResolvedValue({ success: false, error: 'Invalid API key' });

    renderPanel();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('settings:ombi.url'), 'http://localhost:5000');
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'bad-key');
    await user.click(screen.getByRole('button', { name: 'servers.testConnection' }));

    expect(await screen.findByText('Invalid API key')).toBeInTheDocument();
  });

  it('disables Sync Now while the connector is unconfigured', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: /settings:ombi.syncNow/ })).toBeDisabled();
  });
});
