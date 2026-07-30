import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { RefreshCw, Loader2, History } from 'lucide-react';
import { WS_EVENTS } from '@tracearr/shared';
import type { PlayedStateServerSyncStatus, PlayedStateSyncProgress } from '@tracearr/shared';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { usePlayedStateStatus, usePlayedStateSync } from '@/hooks/queries';
import { formatDistanceToNow } from 'date-fns';

// A narrowed callable shape for `t()` - the real TFunction's generic overloads
// make it awkward to pass around as a parameter type (mirrors OmbiSettings).
type Translate = (key: string, options?: Record<string, unknown>) => string;

function statusBadge(
  status: PlayedStateServerSyncStatus['status'],
  t: Translate
): { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' | 'outline' } {
  switch (status) {
    case 'success':
      return { label: t('settings:playedState.statusSuccess'), variant: 'success' };
    case 'partial':
      return { label: t('settings:playedState.statusPartial'), variant: 'warning' };
    case 'error':
      return { label: t('settings:playedState.statusError'), variant: 'destructive' };
    case 'running':
      return { label: t('settings:playedState.statusRunning'), variant: 'secondary' };
    case 'never_run':
    default:
      return { label: t('settings:playedState.statusNeverRun'), variant: 'outline' };
  }
}

interface ServerCardProps {
  server: PlayedStateServerSyncStatus;
  progress: PlayedStateSyncProgress | undefined;
  canSync: boolean;
  onSync: (serverId: string) => void;
  isSyncing: boolean;
  t: Translate;
}

function PlayedStateServerCard({
  server,
  progress,
  canSync,
  onSync,
  isSyncing,
  t,
}: ServerCardProps) {
  const isUnsupported = server.capability === 'unsupported';
  const isRunning = server.status === 'running' || progress?.status === 'running';
  const badge = statusBadge(server.status, t);
  const progressPct =
    progress && progress.totalUsers > 0
      ? Math.round((progress.processedUsers / progress.totalUsers) * 100)
      : 0;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{server.serverName}</span>
          {isUnsupported ? (
            <Badge variant="outline" title={t('settings:playedState.capabilityUnsupportedDesc')}>
              {t('settings:playedState.capabilityUnsupported')}
            </Badge>
          ) : (
            <Badge variant={badge.variant}>{badge.label}</Badge>
          )}
        </div>
        {!isUnsupported && canSync && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onSync(server.serverId)}
            disabled={isRunning || isSyncing}
          >
            {isRunning || isSyncing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isRunning || isSyncing
              ? t('settings:playedState.syncing')
              : t('settings:playedState.syncNow')}
          </Button>
        )}
      </div>

      {isUnsupported ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {t('settings:playedState.capabilityUnsupportedDesc')}
        </p>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-muted-foreground">
              {t('settings:playedState.lastSynced')}:{' '}
              <span className="text-foreground font-medium">
                {server.completedAt
                  ? formatDistanceToNow(new Date(server.completedAt), { addSuffix: true })
                  : t('settings:playedState.never')}
              </span>
            </span>
            {server.usersTotal > 0 && (
              <span className="text-muted-foreground">
                {t('settings:playedState.usersSynced', {
                  synced: server.usersSynced,
                  total: server.usersTotal,
                })}
              </span>
            )}
            {server.itemsUpserted > 0 && (
              <span className="text-muted-foreground">
                {t('settings:playedState.itemsUpserted', { count: server.itemsUpserted })}
              </span>
            )}
            {server.itemsPruned > 0 && (
              <span className="text-muted-foreground">
                {t('settings:playedState.itemsPruned', { count: server.itemsPruned })}
              </span>
            )}
          </div>

          {isRunning && (
            <div className="space-y-1.5">
              <Progress value={progress ? progressPct : undefined} className="h-1.5" />
              {progress?.message && (
                <p className="text-muted-foreground text-xs">{progress.message}</p>
              )}
            </div>
          )}

          {server.error && (
            <p className="text-destructive text-xs break-words">
              {t('settings:playedState.lastError')}: {server.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Settings/Tasks surface for played-state sync (docs/architecture/emby-played-state-sync.md §7.7):
 * one status card per server, a "Sync now" trigger (owner/admin only), and
 * live progress via WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS + the generic
 * `tasks:updated` event (which also drives the global running-tasks dropdown).
 */
export function PlayedStateSettings() {
  const { t: rawT } = useTranslation(['settings', 'notifications', 'common']);
  const t = rawT as unknown as Translate;
  const { user } = useAuth();
  const canSync = user?.role === 'owner' || user?.role === 'admin';
  const { socket } = useSocket();

  const status = usePlayedStateStatus();
  const syncNow = usePlayedStateSync();
  const [progressByServer, setProgressByServer] = useState<Record<string, PlayedStateSyncProgress>>(
    {}
  );

  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: PlayedStateSyncProgress) => {
      setProgressByServer((prev) => ({ ...prev, [progress.serverId]: progress }));
      if (progress.status === 'complete' || progress.status === 'error') {
        void status.refetch();
      }
    };

    // Scheduled (non-manual) runs surface only through `tasks:updated` - refetch
    // status on it too so a server card started by the 12h schedule (not this
    // browser's "Sync now" click) still reflects "running" without a reload.
    const handleTasksUpdated = () => {
      void status.refetch();
    };

    socket.on(WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS, handleProgress);
    socket.on('tasks:updated', handleTasksUpdated);
    return () => {
      socket.off(WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS, handleProgress);
      socket.off('tasks:updated', handleTasksUpdated);
    };
  }, [socket, status]);

  const handleSync = (serverId: string) => {
    setProgressByServer((prev) => {
      const next = { ...prev };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete next[serverId];
      return next;
    });
    syncNow.mutate(serverId);
  };

  const servers = status.data?.servers ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          {t('settings:playedState.title')}
        </CardTitle>
        <CardDescription>{t('settings:playedState.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-muted-foreground text-sm">{t('settings:playedState.noServers')}</p>
          </div>
        ) : (
          <>
            {servers.map((server) => (
              <PlayedStateServerCard
                key={server.serverId}
                server={server}
                progress={progressByServer[server.serverId]}
                canSync={canSync}
                onSync={handleSync}
                isSyncing={syncNow.isPending && syncNow.variables === server.serverId}
                t={t}
              />
            ))}
            {!canSync && (
              <p className="text-muted-foreground text-xs">
                {t('settings:playedState.ownerOnlyNote')}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
