/**
 * React Query hooks for the played-state sync feature (per-server status +
 * manual trigger). Contract: docs/architecture/emby-played-state-sync.md §7.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';

/** GET /library/played-state/status - one row per server, coverage + last run. */
export function usePlayedStateStatus(enabled: boolean = true) {
  return useQuery({
    queryKey: ['library', 'played-state', 'status'],
    queryFn: api.library.playedState.status,
    staleTime: 1000 * 10, // 10 seconds - status can change from a running sync
    enabled,
  });
}

/**
 * POST /library/played-state/sync - manual trigger for one server (or every
 * capable server when `serverId` is omitted).
 * Callers should branch on `ApiError.status` (409 = already running,
 * 400 = unsupported/unknown server) rather than the message text - this hook
 * already surfaces the right toast for both.
 */
export function usePlayedStateSync() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverId?: string) => api.library.playedState.sync(serverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['library', 'played-state', 'status'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t('notifications:toast.error.playedStateSyncAlreadyRunning'));
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        toast.error(t('notifications:toast.error.playedStateSyncUnsupported'));
        return;
      }
      toast.error(t('notifications:toast.error.playedStateSyncFailed'), {
        description: err.message,
      });
    },
  });
}
