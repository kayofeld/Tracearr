import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

// OMB-3 regression coverage: a silent (auto-triggered) sync must not surface
// the "already running" toast on 409, while the manual "Sync now" trigger
// must keep showing it.
const mockSync = vi.fn();
vi.mock('@/lib/api', async () => {
  // `actual.api` is a class instance - spreading it would drop its prototype
  // (including `ApiError`'s), so monkey-patch the one method under test
  // instead of cloning the module (mirrors OmbiSettings.test.tsx).
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  actual.api.ombi.sync = (() => mockSync()) as typeof actual.api.ombi.sync;
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
import { useOmbiSync } from './useOmbi';

const mockToastError = vi.mocked(toast.error);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useOmbiSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not surface an error toast for a 409 on a silent (auto-triggered) sync', async () => {
    mockSync.mockRejectedValueOnce(new ApiError('already running', 409));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOmbiSync(), { wrapper: wrapper(client) });

    result.current.mutate({ silent: true });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('surfaces the "already running" toast for a 409 on a manual sync (no silent flag)', async () => {
    mockSync.mockRejectedValueOnce(new ApiError('already running', 409));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOmbiSync(), { wrapper: wrapper(client) });

    result.current.mutate({});

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith('notifications:toast.error.ombiSyncAlreadyRunning');
  });
});
