import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Server } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

// Local storage keys
const SELECTED_SERVERS_KEY = 'tracearr_selected_servers';
const LEGACY_SELECTED_SERVER_KEY = 'tracearr_selected_server';

interface ServerContextValue {
  servers: Server[];
  selectedServerIds: string[];
  selectedServers: Server[];
  isMultiServer: boolean;
  isAllServersSelected: boolean;
  isLoading: boolean;
  isFetching: boolean;
  toggleServer: (serverId: string) => void;
  selectAllServers: () => void;
  deselectAllExcept: (serverId: string) => void;
  refetch: () => Promise<unknown>;

  /**
   * @deprecated Use `selectedServerIds` and the multi-server query pattern.
   * Returns null when more than one server is selected. Excluded pages
   * (/users, /stats/users, /settings/*) still consume this; everything
   * else should migrate to `selectedServerIds`.
   */
  selectedServerId: string | null;
  /**
   * @deprecated Use `selectedServers`. Returns null when multi-server is active.
   */
  selectedServer: Server | null;
  /**
   * @deprecated Use `toggleServer`/`selectAllServers`/`deselectAllExcept`.
   */
  selectServer: (serverId: string) => void;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();

  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(SELECTED_SERVERS_KEY);
      if (stored) return JSON.parse(stored) as string[];
    } catch {
      /* ignore parse errors */
    }
    // Fall back to legacy single-server key
    const legacy = localStorage.getItem(LEGACY_SELECTED_SERVER_KEY);
    return legacy ? [legacy] : [];
  });

  // Fetch available servers (only when authenticated)
  const {
    data: servers = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.servers.list(),
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Filter servers by user's accessible serverIds (non-owners only see assigned servers)
  const accessibleServers = useMemo(() => {
    if (!user) return [];
    if (user.role === 'owner') return servers;
    return servers.filter((s) => user.serverIds.includes(s.id));
  }, [servers, user]);

  // Validate selection when servers load
  useEffect(() => {
    if (isLoading || !user) return;

    if (accessibleServers.length === 0) {
      if (selectedServerIds.length > 0) {
        setSelectedServerIds([]);
        localStorage.removeItem(SELECTED_SERVERS_KEY);
        localStorage.removeItem(LEGACY_SELECTED_SERVER_KEY);
      }
      return;
    }

    // Remove any IDs not in accessible servers
    const accessibleIds = new Set(accessibleServers.map((s) => s.id));
    const validated = selectedServerIds.filter((id) => accessibleIds.has(id));

    // If result is empty, select all accessible servers (default)
    const next = validated.length > 0 ? validated : accessibleServers.map((s) => s.id);

    if (
      next.length !== selectedServerIds.length ||
      next.some((id, i) => id !== selectedServerIds[i])
    ) {
      setSelectedServerIds(next);
      localStorage.setItem(SELECTED_SERVERS_KEY, JSON.stringify(next));
    }
  }, [accessibleServers, selectedServerIds, isLoading, user]);

  // Clear selection on logout
  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedServerIds([]);
      localStorage.removeItem(SELECTED_SERVERS_KEY);
      localStorage.removeItem(LEGACY_SELECTED_SERVER_KEY);
    }
  }, [isAuthenticated]);

  const invalidateServerQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== 'servers',
    });
  }, [queryClient]);

  const toggleServer = useCallback(
    (serverId: string) => {
      setSelectedServerIds((prev) => {
        const next = prev.includes(serverId)
          ? prev.filter((id) => id !== serverId)
          : [...prev, serverId];
        // Prevent empty selection
        if (next.length === 0) return prev;
        localStorage.setItem(SELECTED_SERVERS_KEY, JSON.stringify(next));
        return next;
      });
      invalidateServerQueries();
    },
    [invalidateServerQueries]
  );

  const selectAllServers = useCallback(() => {
    const allIds = accessibleServers.map((s) => s.id);
    setSelectedServerIds(allIds);
    localStorage.setItem(SELECTED_SERVERS_KEY, JSON.stringify(allIds));
    invalidateServerQueries();
  }, [accessibleServers, invalidateServerQueries]);

  const deselectAllExcept = useCallback(
    (serverId: string) => {
      setSelectedServerIds([serverId]);
      localStorage.setItem(SELECTED_SERVERS_KEY, JSON.stringify([serverId]));
      invalidateServerQueries();
    },
    [invalidateServerQueries]
  );

  // Backward compat: selectServer sets single selection
  const selectServer = useCallback(
    (serverId: string) => {
      deselectAllExcept(serverId);
    },
    [deselectAllExcept]
  );

  // Computed values
  const isMultiServer = selectedServerIds.length > 1;
  const isAllServersSelected = selectedServerIds.length === accessibleServers.length;
  const selectedServers = useMemo(
    () => accessibleServers.filter((s) => selectedServerIds.includes(s.id)),
    [accessibleServers, selectedServerIds]
  );

  // Backward compat
  const selectedServerId = selectedServerIds.length === 1 ? (selectedServerIds[0] ?? null) : null;
  const selectedServer = useMemo(() => {
    if (!selectedServerId) return null;
    return accessibleServers.find((s) => s.id === selectedServerId) ?? null;
  }, [accessibleServers, selectedServerId]);

  const value = useMemo<ServerContextValue>(
    () => ({
      servers: accessibleServers,
      selectedServerIds,
      selectedServers,
      isMultiServer,
      isAllServersSelected,
      isLoading,
      isFetching,
      toggleServer,
      selectAllServers,
      deselectAllExcept,
      refetch,
      // Backward compat
      selectedServerId,
      selectedServer,
      selectServer,
    }),
    [
      accessibleServers,
      selectedServerIds,
      selectedServers,
      isMultiServer,
      isAllServersSelected,
      isLoading,
      isFetching,
      toggleServer,
      selectAllServers,
      deselectAllExcept,
      refetch,
      selectedServerId,
      selectedServer,
      selectServer,
    ]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerContextValue {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error('useServer must be used within a ServerProvider');
  }
  return context;
}

// Convenience hook to get just the selected server IDs
export function useSelectedServerIds(): string[] {
  const { selectedServerIds } = useServer();
  return selectedServerIds;
}

/**
 * @deprecated Use `useSelectedServerIds()` and the multi-server query pattern.
 */
export function useSelectedServerId(): string | null {
  const { selectedServerId } = useServer();
  return selectedServerId;
}
