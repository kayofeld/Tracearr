import { useQuery } from '@tanstack/react-query';
import type { MediaType, DeviceCompatibilityMatrix } from '@tracearr/shared';
import { api, type StatsTimeRange, getBrowserTimezone } from '@/lib/api';
import { useMultiServerQuery, type MultiServerQueryResult } from '@/hooks/useMultiServerQuery';

// Re-export for backwards compatibility and convenience
export type { StatsTimeRange };

export function useDashboardStats(serverIds: string[]) {
  // Include timezone in cache key since "today" varies by timezone
  const timezone = getBrowserTimezone();
  const serverIdsKey = serverIds.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'dashboard', serverIdsKey, timezone],
    queryFn: () => api.stats.dashboard(serverIds.length ? serverIds : undefined),
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // 1 minute
  });
}

export function usePlaysStats(timeRange?: StatsTimeRange, serverIds?: string[]) {
  // Include timezone in cache key since plays are grouped by local day
  const timezone = getBrowserTimezone();
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'plays', timeRange, serverIdsKey, timezone],
    queryFn: () => api.stats.plays(timeRange ?? { period: 'week' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'users', timeRange, serverId],
    queryFn: () => api.stats.users(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface LocationStatsFilters {
  timeRange?: StatsTimeRange;
  serverUserId?: string;
  serverIds?: string[];
  mediaType?: 'movie' | 'episode' | 'track';
}

export function useLocationStats(filters?: LocationStatsFilters) {
  const serverIdsKey = filters?.serverIds?.length ? [...filters.serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: [
      'stats',
      'locations',
      serverIdsKey,
      filters?.serverUserId,
      filters?.mediaType,
      filters?.timeRange,
    ],
    queryFn: () => api.stats.locations(filters),
    staleTime: 1000 * 60, // 1 minute
  });
}

export function usePlaysByDayOfWeek(timeRange?: StatsTimeRange, serverIds?: string[]) {
  // Include timezone in cache key since day-of-week varies by timezone
  const timezone = getBrowserTimezone();
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'plays-by-dayofweek', timeRange, serverIdsKey, timezone],
    queryFn: () => api.stats.playsByDayOfWeek(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlaysByHourOfDay(timeRange?: StatsTimeRange, serverIds?: string[]) {
  // Include timezone in cache key since hour-of-day varies by timezone
  const timezone = getBrowserTimezone();
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'plays-by-hourofday', timeRange, serverIdsKey, timezone],
    queryFn: () => api.stats.playsByHourOfDay(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlatformStats(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'platforms', timeRange, serverIdsKey],
    queryFn: () => api.stats.platforms(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useQualityStats(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'quality', timeRange, serverIdsKey],
    queryFn: () => api.stats.quality(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopUsers(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'top-users', timeRange, serverId],
    queryFn: () => api.stats.topUsers(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopContent(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'top-content', timeRange, serverId],
    queryFn: () => api.stats.topContent(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useConcurrentStats(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'concurrent', timeRange, serverIdsKey],
    queryFn: () => api.stats.concurrent(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface EngagementStatsOptions {
  mediaType?: MediaType;
  limit?: number;
}

export function useEngagementStats(
  timeRange?: StatsTimeRange,
  serverIds?: string[],
  options?: EngagementStatsOptions
) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'engagement', timeRange, serverIdsKey, options],
    queryFn: () => api.stats.engagement(timeRange ?? { period: 'week' }, serverIds, options),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface ShowStatsOptions {
  limit?: number;
  orderBy?: 'totalEpisodeViews' | 'totalWatchHours' | 'bingeScore' | 'uniqueViewers';
}

export function useShowStats(
  timeRange?: StatsTimeRange,
  serverId?: string | null,
  options?: ShowStatsOptions
) {
  return useQuery({
    queryKey: ['stats', 'shows', timeRange, serverId, options],
    queryFn: () =>
      api.stats.shows(timeRange ?? { period: 'month' }, serverId ?? undefined, options),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Device compatibility stats
export function useDeviceCompatibility(
  timeRange?: StatsTimeRange,
  serverIds?: string[],
  minSessions = 5
) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'device-compatibility', timeRange, serverIdsKey, minSessions],
    queryFn: () =>
      api.stats.deviceCompatibility(timeRange ?? { period: 'month' }, serverIds, minSessions),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Fan-out: calls the single-server matrix endpoint once per selected server.
export function useDeviceCompatibilityMatrix(
  serverIds: string[],
  timeRange?: StatsTimeRange,
  minSessions = 5
): MultiServerQueryResult<DeviceCompatibilityMatrix> {
  return useMultiServerQuery(serverIds, (id) => ({
    queryKey: ['stats', 'device-compatibility-matrix', id, timeRange, minSessions],
    queryFn: () =>
      api.stats.deviceCompatibilityMatrix(timeRange ?? { period: 'month' }, id, minSessions),
    staleTime: 1000 * 60 * 5,
  }));
}

export function useDeviceHealth(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'device-health', timeRange, serverIdsKey],
    queryFn: () => api.stats.deviceHealth(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTranscodeHotspots(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'transcode-hotspots', timeRange, serverIdsKey],
    queryFn: () => api.stats.transcodeHotspots(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopTranscodingUsers(timeRange?: StatsTimeRange, serverIds?: string[]) {
  const serverIdsKey = serverIds?.length ? [...serverIds].sort().join(',') : 'all';
  return useQuery({
    queryKey: ['stats', 'top-transcoding-users', timeRange, serverIdsKey],
    queryFn: () => api.stats.topTranscodingUsers(timeRange ?? { period: 'month' }, serverIds),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Bandwidth stats
export function useBandwidthDaily(
  timeRange?: StatsTimeRange,
  serverId?: string | null,
  serverUserId?: string
) {
  // Include timezone in cache key since bandwidth is grouped by local day
  const timezone = getBrowserTimezone();
  return useQuery({
    queryKey: ['stats', 'bandwidth-daily', timeRange, serverId, serverUserId, timezone],
    queryFn: () =>
      api.stats.bandwidthDaily(
        timeRange ?? { period: 'month' },
        serverId ?? undefined,
        serverUserId
      ),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useBandwidthTopUsers(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'bandwidth-top-users', timeRange, serverId],
    queryFn: () =>
      api.stats.bandwidthTopUsers(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useBandwidthSummary(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'bandwidth-summary', timeRange, serverId],
    queryFn: () =>
      api.stats.bandwidthSummary(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
