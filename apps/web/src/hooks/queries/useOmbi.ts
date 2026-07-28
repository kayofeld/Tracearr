/**
 * React Query hooks for the Ombi connector (owner-gated connection, sync,
 * status and requester-mapping management).
 * Contract: docs/architecture/ombi-api-contract.md
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { OmbiMappingUpsertRequest } from '@tracearr/shared';
import { api, ApiError } from '@/lib/api';

/** GET /ombi/status - connector configuration + sync health. Not cached server-side. */
export function useOmbiStatus(enabled: boolean = true) {
  return useQuery({
    queryKey: ['ombi', 'status'],
    queryFn: api.ombi.status,
    staleTime: 1000 * 10, // 10 seconds - status can change from a running sync
    enabled,
  });
}

/** GET /ombi/mappings - one entry per distinct requester seen in ombi_requests. */
export function useOmbiMappings(enabled: boolean = true) {
  return useQuery({
    queryKey: ['ombi', 'mappings'],
    queryFn: api.ombi.mappings.list,
    staleTime: 1000 * 30,
    enabled,
  });
}

/**
 * POST /ombi/sync - manual sync trigger.
 * Callers should branch on `ApiError.status` (409 = already running,
 * 400 = connector not configured) rather than the message text.
 */
export function useOmbiSync() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.ombi.sync,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ombi', 'status'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t('notifications:toast.error.ombiSyncAlreadyRunning'));
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        toast.error(t('notifications:toast.error.ombiSyncNotConfigured'));
        return;
      }
      toast.error(t('notifications:toast.error.ombiSyncFailed'), { description: err.message });
    },
  });
}

/**
 * DELETE /ombi/data - purge mirrored request/mapping rows. Only actionable
 * once the connector is disconnected (server enforces via 409).
 */
export function useOmbiPurge() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.ombi.purge,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ombi'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.ombiDataPurged.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.ombiPurgeFailed'), { description: err.message });
    },
  });
}

/** PUT /ombi/mappings/:ombiUserId - set/force a mapping (null userId = force-unattributed). */
export function useUpsertOmbiMapping() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ombiUserId, data }: { ombiUserId: string; data: OmbiMappingUpsertRequest }) =>
      api.ombi.mappings.upsert(ombiUserId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ombi', 'mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['ombi', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.ombiMappingUpdated.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.ombiMappingUpdateFailed'), {
        description: err.message,
      });
    },
  });
}

/** DELETE /ombi/mappings/:ombiUserId - revert to the automatic resolution pipeline. */
export function useRevertOmbiMapping() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ombiUserId: string) => api.ombi.mappings.revert(ombiUserId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ombi', 'mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['ombi', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'requesters'] });
      toast.success(t('notifications:toast.success.ombiMappingReverted.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.ombiMappingUpdateFailed'), {
        description: err.message,
      });
    },
  });
}
