/**
 * React Query hooks for the Docker/Portainer redeploy webhook (owner-only).
 *
 * The webhook URL is set/cleared through the same generic PATCH /settings
 * endpoint the Ombi/Seerr connectors use (api.settings.setDockerRedeployWebhook),
 * but is intentionally excluded from the `Settings` type/`useUpdateSettings()`
 * hook - the server never echoes it back (the embedded webhook UUID is the
 * auth secret). Both mutations invalidate the update-capability query key so
 * the settings screen's badge and the update dialog's button availability
 * never disagree.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { UPDATE_CAPABILITY_QUERY_KEY } from './useVersion';

/** Set (or replace) the Portainer redeploy webhook URL. */
export function useSetDockerRedeployWebhook() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (url: string) => api.settings.setDockerRedeployWebhook(url),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UPDATE_CAPABILITY_QUERY_KEY });
      toast.success(t('notifications:toast.success.updateWebhookSaved.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.updateWebhookSaveFailed'), {
        description: err.message,
      });
    },
  });
}

/** Clear the configured webhook (disables the update button again). */
export function useClearDockerRedeployWebhook() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.settings.setDockerRedeployWebhook(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UPDATE_CAPABILITY_QUERY_KEY });
      toast.success(t('notifications:toast.success.updateWebhookCleared.title'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.updateWebhookClearFailed'), {
        description: err.message,
      });
    },
  });
}
