import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, HardDrive, Film, Tv, Calendar, TrendingUp } from 'lucide-react';
import type { GrowthDataPoint, LibraryGrowthResponse } from '@tracearr/shared';
import { StatCard, formatNumber } from '@/components/ui/stat-card';
import { LibraryStatsSkeleton } from '@/components/ui/skeleton';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LibraryEmptyState } from '@/components/library';
import { LibraryGrowthChart } from '@/components/charts';
import { ServerBadge } from '@/components/server';
import { useLibraryStats, useLibraryGrowth, useLibraryStatus } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { formatBytes } from '@/lib/formatters';
import { getHour12 } from '@/lib/timeFormat';
import type { LibraryStatusResponse } from '@/hooks/queries';
import type { Server } from '@tracearr/shared';

/**
 * Format date for last updated display
 */
function formatLastUpdated(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: getHour12(),
  });
}

/**
 * Aggregate multi-server growth response into a single-server-shaped object.
 * Points from the same day across different servers are summed per media type.
 * When only one server is selected the response already has one point per day
 * so this is a no-op (identity over the map).
 */
function aggregateGrowthData(raw: LibraryGrowthResponse): LibraryGrowthResponse {
  const aggregate = (series: GrowthDataPoint[]): GrowthDataPoint[] => {
    const byDay = new Map<string, { total: number; additions: number }>();
    for (const point of series) {
      const existing = byDay.get(point.day);
      if (existing) {
        existing.total += point.total;
        existing.additions += point.additions;
      } else {
        byDay.set(point.day, { total: point.total, additions: point.additions });
      }
    }
    return Array.from(byDay.entries()).map(([day, vals]) => ({
      day,
      total: vals.total,
      additions: vals.additions,
      serverId: '',
    }));
  };

  return {
    period: raw.period,
    movies: aggregate(raw.movies ?? []),
    episodes: aggregate(raw.episodes ?? []),
    music: aggregate(raw.music ?? []),
  };
}

/**
 * Servers that need attention: isSynced is false, needsBackfill is true,
 * or backfill is running.
 */
function serversNeedingSync(
  statusByServer: Map<string, { data?: LibraryStatusResponse }>,
  selectedServers: Server[]
): Server[] {
  return selectedServers.filter((server) => {
    const result = statusByServer.get(server.id);
    const data = result?.data;
    if (!data) return false;
    return !data.isSynced || data.needsBackfill || data.isBackfillRunning;
  });
}

export function LibraryOverview() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  const statusResult = useLibraryStatus(selectedServerIds);
  const { data: stats, isLoading, isError, error, refetch } = useLibraryStats(selectedServerIds);

  // Map TimeRangePicker periods to API format
  const apiPeriod = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return '7d';
      case 'month':
        return '30d';
      case 'year':
        return '1y';
      case 'all':
        return 'all';
      default:
        return '30d';
    }
  }, [timeRange.period]);

  const growth = useLibraryGrowth(selectedServerIds, null, apiPeriod);

  // Aggregate multi-server growth before passing to chart; single-server is a no-op.
  const aggregatedGrowth = useMemo<LibraryGrowthResponse | undefined>(() => {
    if (!growth.data) return undefined;
    return aggregateGrowthData(growth.data);
  }, [growth.data]);

  // Calculate period changes from aggregated growth data
  const periodChanges = useMemo(() => {
    if (!aggregatedGrowth) {
      return { movies: 0, episodes: 0, music: 0, total: 0 };
    }

    const sumAdditions = (series: GrowthDataPoint[] | undefined) =>
      series?.reduce((sum, d) => sum + d.additions, 0) ?? 0;

    const movies = sumAdditions(aggregatedGrowth.movies);
    const episodes = sumAdditions(aggregatedGrowth.episodes);
    const music = sumAdditions(aggregatedGrowth.music);

    return { movies, episodes, music, total: movies + episodes + music };
  }, [aggregatedGrowth]);

  // Period label for display
  const periodLabel = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return t('library.overview.thisWeek');
      case 'month':
        return t('library.overview.thisMonth');
      case 'year':
        return t('library.overview.thisYear');
      case 'all':
        return t('common:time.allTime').toLowerCase();
      default:
        return t('library.overview.thisPeriod');
    }
  }, [timeRange.period, t]);

  // Determine which servers (if any) need sync/backfill attention
  const unreadyServers = useMemo(
    () => serversNeedingSync(statusResult.byServer, selectedServers),
    [statusResult.byServer, selectedServers]
  );

  // Show loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* Header with time range picker */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('library.title')}</h1>
            <p className="text-muted-foreground text-sm">{t('library.overview.description')}</p>
          </div>
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
        </div>
        <LibraryStatsSkeleton />
      </div>
    );
  }

  // Show error state with retry
  if (isError) {
    return (
      <div className="space-y-6">
        {/* Header with time range picker */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('library.title')}</h1>
            <p className="text-muted-foreground text-sm">{t('library.overview.description')}</p>
          </div>
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
        </div>
        <ErrorState
          title={t('library.overview.failedToLoad')}
          message={error?.message ?? t('library.overview.failedToLoadDesc')}
          onRetry={refetch}
        />
      </div>
    );
  }

  // Show empty state when ALL selected servers need setup (status loaded, none ready).
  // In multi-server mode we only block the full page if every server is unready;
  // if some are ready, the KPI cards show the aggregate for those that responded.
  const allStatusLoaded = !statusResult.isLoading;
  const allServersUnready =
    allStatusLoaded &&
    selectedServerIds.length > 0 &&
    unreadyServers.length === selectedServerIds.length;

  if (allServersUnready) {
    return (
      <div className="space-y-6">
        {/* Header with time range picker */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('library.title')}</h1>
            <p className="text-muted-foreground text-sm">{t('library.overview.description')}</p>
          </div>
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
        </div>
        <LibraryEmptyState onComplete={refetch} />
      </div>
    );
  }

  // Format period change for display
  const periodChangeLabel =
    periodChanges.total > 0 ? `+${formatNumber(periodChanges.total)} ${periodLabel}` : undefined;

  return (
    <div className="space-y-6">
      {/* Header with last updated and time range picker */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('library.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('library.overview.description')}</p>
          <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
            <Calendar className="h-3 w-3" />
            <span>
              {t('library.overview.lastUpdated')} {formatLastUpdated(stats?.asOf)}
            </span>
          </div>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Sync-needed banner: shown when some (but not all) servers need attention */}
      {unreadyServers.length > 0 && !allServersUnready && (
        <div className="bg-muted border-border flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm">
          <span className="text-muted-foreground shrink-0">
            {t('library.overview.serversNeedSync', 'These servers need to sync:')}
          </span>
          {isMultiServer
            ? unreadyServers.map((server) => (
                <ServerBadge key={server.id} server={server} variant="outlined" />
              ))
            : null}
        </div>
      )}

      {/* KPI Cards Grid - 5 columns on desktop, 3 on tablet, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={Database}
          label={t('library.overview.totalItems')}
          value={formatNumber(stats?.totalItems ?? 0)}
          subValue={periodChangeLabel}
          isLoading={growth.isLoading}
        />
        <StatCard
          icon={HardDrive}
          label={t('debug.totalSize')}
          value={formatBytes(stats?.totalSizeBytes)}
        />
        <StatCard
          icon={Film}
          label={t('common:media.movie_plural')}
          value={formatNumber(stats?.movieCount ?? 0)}
        />
        <StatCard
          icon={Tv}
          label={t('common:media.episode_plural')}
          value={formatNumber(stats?.episodeCount ?? 0)}
          subValue={
            stats?.showCount
              ? `${formatNumber(stats.showCount)} ${t('library.overview.shows')}`
              : undefined
          }
        />
        <StatCard
          icon={TrendingUp}
          label={t('library.overview.added')}
          value={`+${formatNumber(periodChanges.total)}`}
          subValue={periodLabel}
          isLoading={growth.isLoading}
        />
      </div>

      {/* Library Growth */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {t('library.overview.libraryGrowth')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LibraryGrowthChart
            data={aggregatedGrowth}
            isLoading={growth.isLoading}
            height={250}
            period={timeRange.period}
          />
        </CardContent>
      </Card>
    </div>
  );
}
