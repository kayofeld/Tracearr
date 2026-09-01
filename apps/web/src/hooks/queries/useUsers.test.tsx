import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MERGE_SAME_SERVER_CONFIRMATION_REQUIRED } from '@tracearr/shared';

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      list: vi.fn(),
      merge: vi.fn(),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useMergeUsers, useUsers } from './useUsers';

const mockList = vi.mocked(api.users.list);
const mockMerge = vi.mocked(api.users.merge);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes every roster filter through to the list endpoint untouched', async () => {
    mockList.mockResolvedValueOnce({ data: [], meta: { page: 2, pageSize: 100, total: 0 } });

    const params = {
      page: 2,
      pageSize: 100,
      serverIds: ['server-1'],
      includeRemoved: true,
      search: 'bob',
      joinedAfter: '2024-01-01',
      joinedBefore: '2024-02-01',
      activeAfter: '2024-03-01',
      activeBefore: '2024-04-01',
      orderBy: 'trustScore' as const,
      orderDir: 'desc' as const,
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUsers(params), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockList).toHaveBeenCalledWith(params);
  });
});

describe('useMergeUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows no error toast when the merge fails with the same-server sentinel, so the dialog can escalate instead', async () => {
    mockMerge.mockRejectedValueOnce(new Error(MERGE_SAME_SERVER_CONFIRMATION_REQUIRED));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMergeUsers(), { wrapper: wrapper(client) });

    result.current.mutate({ sourceUserId: 'user-a', targetUserId: 'user-b' });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('shows an error toast when the merge fails for any other reason', async () => {
    mockMerge.mockRejectedValueOnce(new Error('server exploded'));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMergeUsers(), { wrapper: wrapper(client) });

    result.current.mutate({ sourceUserId: 'user-a', targetUserId: 'user-b' });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith('toast.error.userMergeFailed', {
      description: 'server exploded',
    });
  });

  it('invalidates users, stats, sessions, and violations caches on success, so identity-shaped aggregates refresh', async () => {
    mockMerge.mockResolvedValueOnce({
      targetUserId: 'user-b',
      movedServerUserIds: ['su-1'],
      wasSameServerCombine: false,
      combinedServerUsers: [],
      auditId: 'audit-1',
      droppedRuleNames: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMergeUsers(), { wrapper: wrapper(client) });

    result.current.mutate({ sourceUserId: 'user-a', targetUserId: 'user-b' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([['users'], ['stats'], ['sessions'], ['violations']])
    );
  });
});
