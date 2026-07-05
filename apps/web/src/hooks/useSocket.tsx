import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { BASE_PATH } from '@/lib/basePath';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ActiveSession,
  ViolationWithDetails,
  DashboardStats,
  NotificationChannelRouting,
  NotificationEventType,
  LibrarySyncProgress,
  TautulliImportProgress,
  JellystatImportProgress,
  MaintenanceJobProgress,
  ServerConnectionStatus,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { useAuth } from './useAuth';
import { useMaintenanceMode } from './useMaintenanceMode';
import { toast } from 'sonner';
import { useChannelRouting } from './queries';
import { api } from '@/lib/api';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface UnhealthyServer {
  serverId: string;
  serverName: string;
  since: Date;
}

interface SocketContextValue {
  socket: TypedSocket | null;
  isConnected: boolean;
  subscribeSessions: () => void;
  unsubscribeSessions: () => void;
  unhealthyServers: UnhealthyServer[];
  serverConnectionStatuses: Map<string, ServerConnectionStatus>;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation(['notifications', 'common']);
  const { isAuthenticated } = useAuth();
  const { isInMaintenance } = useMaintenanceMode();
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState<TypedSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [unhealthyServers, setUnhealthyServers] = useState<UnhealthyServer[]>([]);
  const [serverConnectionStatuses, setServerConnectionStatuses] = useState<
    Map<string, ServerConnectionStatus>
  >(new Map());

  // Get channel routing for web toast preferences
  const { data: routingData } = useChannelRouting();

  // Build a ref to the routing map for access in event handlers
  const routingMapRef = useRef<Map<NotificationEventType, NotificationChannelRouting>>(new Map());

  // Update the ref when routing data changes
  useEffect(() => {
    const newMap = new Map<NotificationEventType, NotificationChannelRouting>();
    routingData?.forEach((r) => newMap.set(r.eventType, r));
    routingMapRef.current = newMap;
  }, [routingData]);

  // Helper to check if web toast is enabled for an event type
  const isWebToastEnabled = useCallback((eventType: NotificationEventType): boolean => {
    const routing = routingMapRef.current.get(eventType);
    // Default to true if routing not yet loaded
    return routing?.webToastEnabled ?? true;
  }, []);

  // Fetch initial server health status on authentication
  useEffect(() => {
    if (!isAuthenticated) {
      setUnhealthyServers([]);
      return;
    }

    api.servers
      .health()
      .then((servers) => {
        setUnhealthyServers(servers.map((s) => ({ ...s, since: new Date() })));
      })
      .catch(() => {
        // Ignore errors - health check is best-effort
      });
  }, [isAuthenticated]);

  // Fetch initial connection statuses on authentication
  useEffect(() => {
    if (!isAuthenticated) {
      setServerConnectionStatuses(new Map());
      return;
    }

    api.servers
      .connectionStatus()
      .then((statuses) => {
        const map = new Map<string, ServerConnectionStatus>();
        for (const s of statuses) map.set(s.serverId, s);
        setServerConnectionStatuses(map);
      })
      .catch(() => {
        // Best-effort, no impact on core functionality
      });
  }, [isAuthenticated]);

  useEffect(() => {
    // Don't connect WebSocket during maintenance mode — server hasn't initialized it yet
    if (!isAuthenticated || isInMaintenance) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
      }
      return;
    }

    // Session cookie rides the handshake via withCredentials
    const newSocket: TypedSocket = io({
      path: `${BASE_PATH}/socket.io`,
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
    });

    // Handle real-time events
    // Note: Since users can filter by server, we invalidate all matching query patterns
    // and let react-query refetch with the appropriate server filter
    newSocket.on(WS_EVENTS.SESSION_STARTED as 'session:started', (session: ActiveSession) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });

      // Show toast if web notifications are enabled for stream_started
      if (isWebToastEnabled('stream_started')) {
        toast.info(t('notifications:toast.info.streamStarted.title'), {
          description: t('notifications:toast.info.streamStarted.message', {
            user: session.user.identityName ?? session.user.username,
            media: session.mediaTitle,
          }),
        });
      }
    });

    newSocket.on(WS_EVENTS.SESSION_STOPPED as 'session:stopped', (_sessionId: string) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history (stopped session now has duration)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });

      // Show toast if web notifications are enabled for stream_stopped
      if (isWebToastEnabled('stream_stopped')) {
        toast.info(t('notifications:toast.info.streamStopped.title'));
      }
    });

    newSocket.on(WS_EVENTS.SESSION_UPDATED as 'session:updated', (_session: ActiveSession) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
    });

    newSocket.on(WS_EVENTS.VIOLATION_NEW as 'violation:new', (violation: ViolationWithDetails) => {
      // Invalidate violations query
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });

      // Show toast notification if web notifications are enabled for violation_detected
      if (isWebToastEnabled('violation_detected')) {
        const toastFn = violation.severity === 'high' ? toast.error : toast.warning;
        toastFn(
          t('notifications:toast.info.violationDetected.title', { ruleName: violation.rule.name }),
          {
            description: t('notifications:toast.info.violationDetected.message', {
              user: violation.user.identityName ?? violation.user.username,
              ruleType: violation.rule.type,
            }),
          }
        );
      }
    });

    newSocket.on(WS_EVENTS.STATS_UPDATED as 'stats:updated', (_stats: DashboardStats) => {
      // Invalidate all dashboard stats queries (they now have server-specific cache keys)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
    });

    newSocket.on(
      WS_EVENTS.VERSION_UPDATE as 'version:update',
      (data: { current: string; latest: string; releaseUrl: string }) => {
        // Invalidate version query to refresh update status
        void queryClient.invalidateQueries({ queryKey: ['version'] });

        // Show toast notification for new version
        toast.info(t('notifications:toast.info.updateAvailable.title'), {
          description: t('notifications:toast.info.updateAvailable.message', {
            version: data.latest,
          }),
          action: {
            label: t('common:actions.view'),
            onClick: () => window.open(data.releaseUrl, '_blank'),
          },
          duration: 10000,
        });
      }
    );

    newSocket.on(
      WS_EVENTS.SERVER_DOWN as 'server:down',
      (data: { serverId: string; serverName: string }) => {
        // Track unhealthy server for persistent banner
        setUnhealthyServers((prev) => {
          // Avoid duplicates
          if (prev.some((s) => s.serverId === data.serverId)) return prev;
          return [...prev, { ...data, since: new Date() }];
        });

        if (isWebToastEnabled('server_down')) {
          toast.error(t('notifications:toast.info.serverOffline.title'), {
            description: t('notifications:toast.info.serverOffline.message', {
              name: data.serverName,
            }),
            duration: 10000,
          });
        }
      }
    );

    newSocket.on(
      WS_EVENTS.SERVER_UP as 'server:up',
      (data: { serverId: string; serverName: string }) => {
        // Remove from unhealthy servers
        setUnhealthyServers((prev) => prev.filter((s) => s.serverId !== data.serverId));

        if (isWebToastEnabled('server_up')) {
          toast.success(t('notifications:toast.info.serverOnline.title'), {
            description: t('notifications:toast.info.serverOnline.message', {
              name: data.serverName,
            }),
          });
        }
      }
    );

    newSocket.on(
      WS_EVENTS.SERVER_CONNECTION as 'server:connection',
      (status: ServerConnectionStatus) => {
        setServerConnectionStatuses((prev) => {
          const next = new Map(prev);
          next.set(status.serverId, status);
          return next;
        });
      }
    );

    // Library sync progress - invalidate library caches when sync completes
    newSocket.on(
      WS_EVENTS.LIBRARY_SYNC_PROGRESS as 'library:sync:progress',
      (progress: LibrarySyncProgress) => {
        if (progress.status === 'complete' || progress.status === 'error') {
          // Invalidate all library queries to refresh storage and stale content
          void queryClient.invalidateQueries({ queryKey: ['library'] });
        }
      }
    );

    // Tautulli import progress - invalidate session data when import completes
    newSocket.on(
      WS_EVENTS.IMPORT_PROGRESS as 'import:progress',
      (progress: TautulliImportProgress) => {
        if (progress.status === 'complete') {
          // Invalidate session history and stats after importing watch history
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
          void queryClient.invalidateQueries({ queryKey: ['users'] });
        }
      }
    );

    // Jellystat import progress - invalidate session data when import completes
    newSocket.on(
      WS_EVENTS.IMPORT_JELLYSTAT_PROGRESS as 'import:jellystat:progress',
      (progress: JellystatImportProgress) => {
        if (progress.status === 'complete') {
          // Invalidate session history and stats after importing watch history
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
          void queryClient.invalidateQueries({ queryKey: ['users'] });
        }
      }
    );

    // Maintenance job progress - invalidate relevant caches when jobs complete
    newSocket.on(
      WS_EVENTS.MAINTENANCE_PROGRESS as 'maintenance:progress',
      (progress: MaintenanceJobProgress) => {
        if (progress.status === 'complete') {
          // Different jobs affect different data
          switch (progress.type) {
            case 'rebuild_timescale_views':
              // Rebuilding views affects all chart/stats data
              void queryClient.invalidateQueries({ queryKey: ['library'] });
              void queryClient.invalidateQueries({ queryKey: ['stats'] });
              void queryClient.invalidateQueries({ queryKey: ['sessions'] });
              break;
            case 'normalize_players':
            case 'normalize_codecs':
              // These affect session/playback data
              void queryClient.invalidateQueries({ queryKey: ['sessions'] });
              void queryClient.invalidateQueries({ queryKey: ['library'] });
              break;
            case 'normalize_countries':
              // Affects geographic data in sessions
              void queryClient.invalidateQueries({ queryKey: ['sessions'] });
              break;
            case 'fix_imported_progress':
              // Affects session progress data
              void queryClient.invalidateQueries({ queryKey: ['sessions'] });
              void queryClient.invalidateQueries({ queryKey: ['stats'] });
              break;
            case 'backfill_user_dates':
              // Affects user data
              void queryClient.invalidateQueries({ queryKey: ['users'] });
              break;
            default:
              // Unknown job type - invalidate common caches as fallback
              void queryClient.invalidateQueries({ queryKey: ['sessions'] });
              void queryClient.invalidateQueries({ queryKey: ['stats'] });
              break;
          }
        }
      }
    );

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [isAuthenticated, isInMaintenance, queryClient, isWebToastEnabled]);

  const subscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('subscribe:sessions');
    }
  }, [socket, isConnected]);

  const unsubscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:sessions');
    }
  }, [socket, isConnected]);

  const value = useMemo<SocketContextValue>(
    () => ({
      socket,
      isConnected,
      subscribeSessions,
      unsubscribeSessions,
      unhealthyServers,
      serverConnectionStatuses,
    }),
    [
      socket,
      isConnected,
      subscribeSessions,
      unsubscribeSessions,
      unhealthyServers,
      serverConnectionStatuses,
    ]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
