/**
 * React Query hooks for the Seerr connector (owner-gated connection, sync,
 * status and requester-mapping management). Mirrors useOmbi.ts exactly -
 * Seerr is a sibling connector, same lifecycle and endpoint shape.
 * Contract: docs/architecture/seerr-api-contract.md
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SeerrMappingUpsertRequest } from '@tracearr/shared';
import { api, ApiError } from '@/lib/api';

/** GET /seerr/status - connector configuration + sync health. Not cached server-side. */
export function useSeerrStatus(enabled: boolean = true) {
  return useQuery({
    queryKey: ['seerr', 'status'],
    queryFn: api.seerr.status,
    staleTime: 1000 * 10, // 10 seconds - status can change from a running sync
    enabled,
  });
}

/** GET /seerr/mappings - one entry per distinct requester seen in media_requests (source='seerr'). */
export function useSeerrMappings(enabled: boolean = true) {
  return useQuery({
    queryKey: ['seerr', 'mappings'],
    queryFn: api.seerr.mappings.list,
    staleTime: 1000 * 30,
    enabled,
  });
}

/**
 * POST /seerr/sync - manual sync trigger, also used for the auto-sync fired
 * on connector configure (see SeerrSettings.handleSave).
 * Callers should branch on `ApiError.status` (409 = already running,
 * 400 = connector not configured) rather than the message text.
 *
 * Pass `{ silent: true }` for a sync triggered automatically (not by the
 * user clicking "Sync now") so a 409 - a scheduled/other sync merely beating
 * this one to it, not a failure - doesn't surface an error toast. The manual
 * "Sync now" button always wants that toast, since there it is informative.
 */
export function useSeerrSync() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (_variables: { silent?: boolean }) => api.seerr.sync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seerr', 'status'] });
    },
    onError: (err, variables) => {
      if (err instanceof ApiError && err.status === 409) {
        if (!variables?.silent) {
          toast.error(t('notifications:toast.error.seerrSyncAlreadyRunning'));
        }
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        toast.error(t('notifications:toast.error.seerrSyncNotConfigured'));
        return;
      }
      toast.error(t('notifications:toast.error.seerrSyncFailed'), { description: err.message });
    },
  });
}

/**
 * DELETE /seerr/data - purge mirrored request/mapping rows. Only actionable
 * once the connector is disconnected (server enforces via 409).
 */
export function useSeerrPurge() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.seerr.purge,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seerr'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.seerrDataPurged.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.seerrPurgeFailed'), { description: err.message });
    },
  });
}

/** PUT /seerr/mappings/:seerrUserId - set/force a mapping (null userId = force-unattributed). */
export function useUpsertSeerrMapping() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ seerrUserId, data }: { seerrUserId: string; data: SeerrMappingUpsertRequest }) =>
      api.seerr.mappings.upsert(seerrUserId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seerr', 'mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['seerr', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.seerrMappingUpdated.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.seerrMappingUpdateFailed'), {
        description: err.message,
      });
    },
  });
}

/** DELETE /seerr/mappings/:seerrUserId - revert to the automatic resolution pipeline. */
export function useRevertSeerrMapping() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (seerrUserId: string) => api.seerr.mappings.revert(seerrUserId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seerr', 'mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['seerr', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.seerrMappingReverted.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.seerrMappingUpdateFailed'), {
        description: err.message,
      });
    },
  });
}
