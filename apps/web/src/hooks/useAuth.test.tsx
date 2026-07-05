import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  api: { auth: { me: vi.fn() } },
  AUTH_STATE_CHANGE_EVENT: 'tracearr:auth-state-change',
  BASE_URL: '/',
}));

vi.mock('@/lib/authClient', () => ({
  authClient: { signOut: vi.fn().mockResolvedValue(undefined) },
}));

import { api } from '@/lib/api';
import { authClient } from '@/lib/authClient';
import { AuthProvider, useAuth } from './useAuth';

const mockMe = vi.mocked(api.auth.me);
const mockSignOut = vi.mocked(authClient.signOut);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the frozen { user, isLoading, isAuthenticated, logout, refetch } shape', async () => {
    mockMe.mockResolvedValue({
      userId: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      thumbnail: null,
      role: 'owner',
      aggregateTrustScore: 100,
      serverIds: ['s1'],
    });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(Object.keys(result.current).sort()).toEqual(
      ['user', 'isLoading', 'isAuthenticated', 'logout', 'refetch'].sort()
    );
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe('alice');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.refetch).toBe('function');
  });

  it('reports unauthenticated when the session lookup fails', async () => {
    mockMe.mockRejectedValue(new Error('401 Unauthorized'));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('logout calls authClient.signOut and clears the cached auth state', async () => {
    mockMe.mockResolvedValueOnce({
      userId: 'u1',
      username: 'alice',
      email: null,
      thumbnail: null,
      role: 'owner',
      aggregateTrustScore: 100,
      serverIds: [],
    });
    // Session is gone once signOut clears the cookie - the invalidated refetch sees no session.
    mockMe.mockRejectedValueOnce(new Error('401 Unauthorized'));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.logout();
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();
  });
});
