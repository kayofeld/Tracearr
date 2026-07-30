import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

const mockSync = vi.fn();
vi.mock('@/lib/api', async () => {
  // `actual.api` is a class instance - spreading it would drop its prototype
  // (including `ApiError`'s), so monkey-patch the one method under test
  // instead of cloning the module (mirrors useOmbi.test.tsx).
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  actual.api.library.playedState.sync = (() =>
    mockSync()) as typeof actual.api.library.playedState.sync;
  return actual;
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ApiError } from '@/lib/api';
import { toast } from 'sonner';
import { usePlayedStateSync } from './usePlayedState';

const mockToastError = vi.mocked(toast.error);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('usePlayedStateSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces the "already running" toast on a 409 (a sync for this server is in progress)', async () => {
    mockSync.mockRejectedValueOnce(new ApiError('already running', 409));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlayedStateSync(), { wrapper: wrapper(client) });

    result.current.mutate('srv-1');

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith(
      'notifications:toast.error.playedStateSyncAlreadyRunning'
    );
  });

  it('surfaces the "unsupported server" toast on a 400 (e.g. a Plex serverId)', async () => {
    mockSync.mockRejectedValueOnce(new ApiError('unsupported', 400));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlayedStateSync(), { wrapper: wrapper(client) });

    result.current.mutate('srv-plex');

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith(
      'notifications:toast.error.playedStateSyncUnsupported'
    );
  });

  it('surfaces a generic failure toast for any other error', async () => {
    mockSync.mockRejectedValueOnce(new Error('network down'));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlayedStateSync(), { wrapper: wrapper(client) });

    result.current.mutate('srv-1');

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith('notifications:toast.error.playedStateSyncFailed', {
      description: 'network down',
    });
  });
});
