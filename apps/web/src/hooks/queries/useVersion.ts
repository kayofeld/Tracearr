import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { VersionInfo } from '@tracearr/shared';
import { api } from '@/lib/api';

/** Query key shared by every consumer of GET /version/update/capability -
 * both the update dialog and the docker-webhook settings screen read (and,
 * on save/clear, invalidate) this same key so they never disagree. */
export const UPDATE_CAPABILITY_QUERY_KEY = ['version', 'update', 'capability'] as const;

/**
 * Hook to fetch current version info and update status
 * Polls every 6 hours to match server-side check frequency
 */
export function useVersion() {
  return useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: api.version.get,
    // Refresh every 6 hours (matches server check interval)
    staleTime: 1000 * 60 * 60 * 6,
    // Refetch in background when window refocuses
    refetchOnWindowFocus: true,
    // Keep retrying - version endpoint should always be available
    retry: 3,
  });
}

/**
 * Hook to fetch whether the in-app "Update" button can be used on this
 * deployment (bare-metal self-update enabled, or Docker with a redeploy
 * webhook configured). Shared by UpdateDialog and the docker-webhook
 * settings screen so both read/react to the same query.
 */
export function useUpdateCapability(enabled: boolean = true) {
  return useQuery({
    queryKey: UPDATE_CAPABILITY_QUERY_KEY,
    queryFn: () => api.version.updateCapability(),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Hook to force a version check (admin only)
 */
export function useForceVersionCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.version.check,
    onSuccess: () => {
      // Invalidate version query to refetch after check completes
      // Small delay to allow the server to process the check
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['version'] });
      }, 2000);
    },
  });
}
