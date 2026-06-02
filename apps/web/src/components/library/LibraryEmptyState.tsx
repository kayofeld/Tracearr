import { useState, useEffect } from 'react';
import { Database, RefreshCw, Clock, Loader2, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api';
import { useServer } from '@/hooks/useServer';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLibraryStatus } from '@/hooks/queries';
import { useSocket } from '@/hooks/useSocket';
import { WS_EVENTS } from '@tracearr/shared';
import type { MaintenanceJobProgress } from '@tracearr/shared';

interface LibraryEmptyStateProps {
  /** Called after sync or backfill completes to refetch page data */
  onComplete?: () => void;
}

/**
 * Unified empty state component for library pages.
 *
 * Automatically detects the current state:
 * 1. Library not synced -> Shows sync button
 * 2. Library synced but needs backfill -> Shows backfill button
 * 3. Backfill running -> Shows progress
 *
 * This replaces LibraryNotSyncedState and LibraryBackfillState.
 */
export function LibraryEmptyState({ onComplete }: LibraryEmptyStateProps) {
  const { selectedServerId } = useServer();
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isStartingBackfill, setIsStartingBackfill] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<MaintenanceJobProgress | null>(null);

  // Get library status to determine which state to show (single-server; wraps into array for hook)
  const statusResult = useLibraryStatus(selectedServerId ? [selectedServerId] : []);
  const status = {
    isLoading: statusResult.isLoading,
    data: selectedServerId ? statusResult.byServer.get(selectedServerId)?.data : undefined,
  };

  // Listen for maintenance progress via WebSocket
  const { socket } = useSocket();

  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: MaintenanceJobProgress) => {
      if (progress.type !== 'backfill_library_snapshots') return;

      setBackfillProgress(progress);

      if (progress.status === 'complete') {
        void queryClient.invalidateQueries({ queryKey: ['library'] });
        onComplete?.();
        toast.success('Backfill complete', {
          description: progress.message,
        });
        setBackfillProgress(null);
      } else if (progress.status === 'error') {
        toast.error('Backfill failed', {
          description: progress.message,
        });
        setBackfillProgress(null);
      }
    };

    socket.on(WS_EVENTS.MAINTENANCE_PROGRESS as 'maintenance:progress', handleProgress);

    return () => {
      socket.off(WS_EVENTS.MAINTENANCE_PROGRESS as 'maintenance:progress', handleProgress);
    };
  }, [socket, queryClient, onComplete]);

  const handleSync = async () => {
    if (!selectedServerId) {
      toast.error('No server selected');
      return;
    }

    setIsSyncing(true);
    try {
      await api.servers.sync(selectedServerId);
      toast.success('Library sync started', {
        description: 'This may take a few minutes depending on library size.',
      });

      // Invalidate queries after a short delay
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['library'] });
        onComplete?.();
      }, 2000);
    } catch (err) {
      toast.error('Failed to start sync', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleBackfill = async () => {
    setIsStartingBackfill(true);
    try {
      await api.maintenance.startJob('backfill_library_snapshots');
      toast.success('Backfill started', {
        description: 'Historical snapshots are being generated.',
      });
      void queryClient.invalidateQueries({ queryKey: ['library', 'status'] });
    } catch (err) {
      toast.error('Failed to start backfill', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setIsStartingBackfill(false);
    }
  };

  // Show loading state while checking status
  if (status.isLoading) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
        <p className="text-muted-foreground mt-4">Checking library status...</p>
      </div>
    );
  }

  const { isSynced, isSyncRunning, needsBackfill, isBackfillRunning, backfillDays } =
    status.data ?? {};

  // Show backfill progress
  if (isBackfillRunning || backfillProgress?.status === 'running') {
    const pct =
      backfillProgress && backfillProgress.totalRecords > 0
        ? Math.round((backfillProgress.processedRecords / backfillProgress.totalRecords) * 100)
        : 0;

    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
        <h3 className="mt-4 text-lg font-medium">Generating historical data...</h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md">
          {backfillProgress?.message ||
            'Creating snapshots from library history. This may take a few minutes.'}
        </p>
        {backfillProgress && backfillProgress.totalRecords > 0 && (
          <div className="mx-auto mt-4 max-w-xs space-y-2">
            <Progress value={pct} className="h-2" />
            <p className="text-muted-foreground text-sm">
              {backfillProgress.processedRecords} of {backfillProgress.totalRecords} libraries
              {backfillProgress.updatedRecords > 0 &&
                ` (${backfillProgress.updatedRecords} snapshots)`}
            </p>
          </div>
        )}
      </div>
    );
  }

  // Show backfill prompt if synced but needs backfill
  if (isSynced && needsBackfill) {
    // If sync is running, show message that backfill will run automatically
    if (isSyncRunning) {
      return (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
          <h3 className="mt-4 text-lg font-medium">Library sync in progress...</h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md">
            Historical data generation will start automatically once the sync completes.
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Clock className="text-muted-foreground/50 mx-auto h-12 w-12" />
        <h3 className="mt-4 text-lg font-medium">Historical data available</h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md">
          {backfillDays
            ? `Your library has ${backfillDays} days of history. Generate snapshots to see trends in charts.`
            : 'Generate historical snapshots to see library trends over time.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={handleBackfill}
          disabled={isStartingBackfill}
        >
          {isStartingBackfill ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Starting...
            </>
          ) : (
            <>
              <BarChart3 className="mr-2 h-4 w-4" />
              Generate History
            </>
          )}
        </Button>
      </div>
    );
  }

  // Default: Library not synced
  // If sync is already running, show progress
  if (isSyncRunning || isSyncing) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
        <h3 className="mt-4 text-lg font-medium">Library sync in progress...</h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md">
          Library statistics will appear once the sync completes. This may take a few minutes
          depending on library size.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <Database className="text-muted-foreground/50 mx-auto h-12 w-12" />
      <h3 className="mt-4 text-lg font-medium">Library not synced yet</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md">
        Library statistics will appear here once the library has been synced. This typically happens
        automatically every hour.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={handleSync}
        disabled={!selectedServerId}
      >
        <RefreshCw className="mr-2 h-4 w-4" />
        Sync Now
      </Button>
    </div>
  );
}
