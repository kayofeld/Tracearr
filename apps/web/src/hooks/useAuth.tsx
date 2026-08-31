import { createContext, useContext, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@tracearr/shared';
import { api, ApiError, AUTH_STATE_CHANGE_EVENT, BASE_URL } from '@/lib/api';
import { authClient } from '@/lib/authClient';

interface UserProfile extends AuthUser {
  email: string | null;
  thumbUrl: string | null;
  trustScore: number;
  hasPassword?: boolean;
  hasPlexLinked?: boolean;
}

interface AuthContextValue {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// 401/403 means the server answered and there is no session. A network error,
// proxy 5xx, or timeout means we never got an answer, so the last user stays.
const isSignedOut = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const {
    data: userData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        const user = await api.auth.me();
        // Return full user profile including thumbUrl
        return {
          userId: user.userId ?? user.id ?? '',
          username: user.username,
          role: user.role,
          serverIds: user.serverIds ?? (user.serverId ? [user.serverId] : []),
          email: user.email ?? null,
          thumbUrl: user.thumbnail ?? user.thumbUrl ?? null,
          trustScore: user.aggregateTrustScore ?? user.trustScore ?? 100,
          hasPassword: user.hasPassword,
          hasPlexLinked: user.hasPlexLinked,
        };
      } catch (error) {
        if (isSignedOut(error)) return null;
        // Thrown errors retry on the client defaults and keep the last user in place
        throw error;
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    // Auto-refetch when network reconnects (handles stale tabs)
    refetchOnReconnect: true,
    // Refetch when window regains focus (handles stale tabs)
    refetchOnWindowFocus: true,
  });

  // Listen for auth state changes (e.g., session cookie rejected by the API)
  useEffect(() => {
    const handleAuthChange = () => {
      // Immediately clear auth data and redirect to login
      queryClient.setQueryData(['auth', 'me'], null);
      queryClient.clear();
      // Assigning location.href reloads even when the URL is unchanged, so a
      // 401 fired while already on the login page would reload it forever.
      if (window.location.pathname !== `${BASE_URL}login`) {
        window.location.href = `${BASE_URL}login`;
      }
    };

    window.addEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
    return () => window.removeEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
  }, [queryClient]);

  const logout = useCallback(async () => {
    await authClient.signOut();
    queryClient.setQueryData(['auth', 'me'], null);
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userData ?? null,
      isLoading,
      isAuthenticated: !!userData,
      logout,
      refetch,
    }),
    [userData, isLoading, logout, refetch]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Hook for protected routes
export function useRequireAuth(): AuthContextValue {
  const auth = useAuth();

  useEffect(() => {
    // Only triggers once the /me query has resolved with no session
    // (never logged in, session expired, or explicitly logged out)
    if (!auth.isAuthenticated) {
      window.location.href = `${BASE_URL}login`;
    }
  }, [auth.isAuthenticated]);

  return auth;
}
