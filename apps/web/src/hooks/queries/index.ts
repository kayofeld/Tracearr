// Stats hooks
export {
  useDashboardStats,
  usePlaysStats,
  useUserStats,
  useLocationStats,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
  usePlatformStats,
  useQualityStats,
  useTopUsers,
  useTopContent,
  useConcurrentStats,
  useEngagementStats,
  useShowStats,
  // Device compatibility
  useDeviceCompatibility,
  useDeviceCompatibilityMatrix,
  useDeviceHealth,
  useTranscodeHotspots,
  useTopTranscodingUsers,
  // Bandwidth stats
  useBandwidthDaily,
  useBandwidthTopUsers,
  useBandwidthSummary,
  // Ombi requester stats
  useRequesterStats,
  type LocationStatsFilters,
  type StatsTimeRange,
  type EngagementStatsOptions,
  type ShowStatsOptions,
} from './useStats';

// Ombi connector hooks (settings, sync, requester mappings)
export {
  useOmbiStatus,
  useOmbiMappings,
  useOmbiSync,
  useOmbiPurge,
  useUpsertOmbiMapping,
  useRevertOmbiMapping,
} from './useOmbi';

// Seerr connector hooks (settings, sync, requester mappings) - sibling to Ombi
export {
  useSeerrStatus,
  useSeerrMappings,
  useSeerrSync,
  useSeerrPurge,
  useUpsertSeerrMapping,
  useRevertSeerrMapping,
} from './useSeerr';

// Session hooks
export { useSessions, useActiveSessions, useSession, useBulkDeleteSessions } from './useSessions';
export { useTerminateSession } from './useTerminateSession';

// History hooks (advanced session queries with infinite scroll)
export {
  useHistorySessions,
  useHistoryAggregates,
  useFilterOptions,
  type HistoryFilters,
  type AggregateFilters,
} from './useHistory';

// User hooks
export {
  useUsers,
  useUser,
  useUserFull,
  useUserSessions,
  useUpdateUser,
  useUpdateUserIdentity,
  useUserLocations,
  useUserDevices,
  useUserTerminations,
  useBulkResetTrust,
  useBulkRemoveUsers,
  useMergeSuggestions,
  useMergeUsers,
  useSplitServerUser,
} from './useUsers';

// Rule hooks
export {
  useRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  useToggleRule,
  useBulkToggleRules,
  useBulkDeleteRules,
} from './useRules';

// Rule V2 hooks
export {
  useCreateRuleV2,
  useUpdateRuleV2,
  useMigrationPreview,
  useMigrateRules,
  useMigrateOneRule,
  isRuleV2,
} from './useRulesV2';

// Violation hooks
export {
  useViolations,
  useViolation,
  useAcknowledgeViolation,
  useDismissViolation,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
} from './useViolations';

// Server hooks
export {
  useServers,
  useCreateServer,
  useDeleteServer,
  useSyncServer,
  useUpdateServer,
  useServerStatistics,
  usePlexServerConnections,
  useReorderServers,
} from './useServers';

// Settings hooks
export { useSettings, useUpdateSettings, useApiKey, useRegenerateApiKey } from './useSettings';

// Channel Routing hooks
export { useChannelRouting, useUpdateChannelRouting } from './useChannelRouting';

// Mobile hooks
export {
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useUpdateMobileSession,
  useRevokeSession,
  useRevokeMobileSessions,
} from './useMobile';

// Tailscale hooks
export {
  useTailscaleStatus,
  useTailscaleLogs,
  useEnableTailscale,
  useDisableTailscale,
  // useSetExitNode, // Exit node disabled - will come back with SOCKS proxy support
  useResetTailscale,
} from './useTailscale';

// Version hooks
export {
  useVersion,
  useForceVersionCheck,
  useUpdateCapability,
  UPDATE_CAPABILITY_QUERY_KEY,
} from './useVersion';

// Docker/Portainer redeploy webhook hooks (owner-only)
export { useSetDockerRedeployWebhook, useClearDockerRedeployWebhook } from './useUpdateWebhook';

// Library hooks
export {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryQuality,
  useLibraryStorage,
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryNeverWatched,
  useLibraryWatch,
  useLibraryCompletion,
  useLibraryPatterns,
  useLibraryRoi,
  useTopMovies,
  useTopShows,
  useLibraryCodecs,
  useLibraryResolution,
  useLibraryStatus,
  type LibraryStatusResponse,
} from './useLibrary';
export type { MultiServerQueryResult } from '@/hooks/useMultiServerQuery';
