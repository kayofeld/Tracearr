import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EyeOff, HardDrive, Percent, CalendarClock, Film, Tv } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { StaleItem, NeverWatchedAgeBucket } from '@tracearr/shared';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { DataTable, type SortingState } from '@/components/ui/data-table';
import { ErrorState, LibraryEmptyState, EmptyState } from '@/components/library';
import { NeverWatchedAgeChart } from '@/components/charts';
import { ServerColumnCell } from '@/components/server';
import {
  useLibraryNeverWatched,
  useLibraryStale,
  useLibraryStatus,
  useRequesterStats,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatBytes } from '@/lib/formatters';

type MediaTypeFilter = 'all' | 'movie' | 'show';
type SortableColumnId = 'title' | 'addedAt' | 'daysStale' | 'fileSize';

const columnToSortBy: Record<SortableColumnId, 'title' | 'added_at' | 'days_stale' | 'size'> = {
  title: 'title',
  addedAt: 'added_at',
  daysStale: 'days_stale',
  fileSize: 'size',
};

// A narrowed callable shape for `t()` - the real TFunction's generic overloads
// make it awkward to pass around as a parameter type, and none of the calls
// below use `returnObjects` or other non-string-returning options.
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Human-readable "time on server" string, e.g. "812 days", "3 months", "2y 3m".
 */
function formatDuration(days: number, t: Translate): string {
  if (days < 30) return t('library.neverWatched.durationDays', { count: days });
  if (days < 365) {
    const months = Math.floor(days / 30);
    return t('library.neverWatched.durationMonths', { count: months });
  }
  const years = Math.floor(days / 365);
  const remainingDays = days % 365;
  const months = Math.floor(remainingDays / 30);
  if (months === 0) return t('library.neverWatched.durationYears', { count: years });
  return t('library.neverWatched.durationYearsMonths', { years, months });
}

/**
 * "Requested by" cell - sourced from either request connector's attribution
 * (StaleItem.requestedBy). Degrades to a muted dash whenever no connector is
 * on, the item matched no request, or requestedBy is otherwise null - never
 * hides the column or errors.
 *
 * `showSource` gates a small connector badge (Ombi/Seerr) - only worth
 * showing once BOTH connectors are configured (a single-connector install
 * never needs to be told which one attributed a row).
 */
function RequestedByCell({
  requestedBy,
  t,
  showSource,
}: {
  requestedBy: StaleItem['requestedBy'];
  t: Translate;
  showSource: boolean;
}) {
  if (!requestedBy) {
    return (
      <span className="text-muted-foreground">{t('library.neverWatched.requestedByNone')}</span>
    );
  }

  const label = requestedBy.ombiAlias ?? requestedBy.ombiUsername;
  const sourceLabel =
    requestedBy.source === 'seerr'
      ? t('library.neverWatched.sourceSeerr')
      : t('library.neverWatched.sourceOmbi');

  return (
    <span className="inline-flex items-center gap-1">
      {requestedBy.username ? (
        <Link to={`/users`} className="hover:underline">
          {requestedBy.username}
        </Link>
      ) : (
        <span>{label}</span>
      )}
      {showSource && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 text-[10px]"
          title={t('library.neverWatched.sourceTooltip', { source: sourceLabel })}
        >
          {sourceLabel}
        </Badge>
      )}
      {requestedBy.otherRequesterCount > 0 && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {t('library.neverWatched.requestedByOthers', { count: requestedBy.otherRequesterCount })}
        </Badge>
      )}
    </span>
  );
}

function MediaTypeCell({ mediaType, t }: { mediaType: string; t: Translate }) {
  if (mediaType === 'movie') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Film className="h-3 w-3" />
        {t('common:media.movie')}
      </Badge>
    );
  }
  if (mediaType === 'show') {
    return (
      <Badge variant="secondary" className="gap-1 bg-blue-500/10 text-blue-500">
        <Tv className="h-3 w-3" />
        {t('common:media.tv')}
      </Badge>
    );
  }
  return null;
}

export function LibraryNeverWatched() {
  const { t } = useTranslation(['pages', 'common']);
  // Narrowed shape used by the module-level helpers (formatDuration, MediaTypeCell) - the
  // real TFunction's overloaded generics don't structurally reduce to `Translate` cleanly.
  const translate = t as unknown as Translate;
  const { selectedServerIds, isMultiServer } = useServer();

  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all');
  const [requestedOnly, setRequestedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'addedAt', desc: false }]);
  const pageSize = 20;

  // Stable key for the selected-server-ids array (its reference changes every
  // render even when its contents don't).
  const serverIdsKey = selectedServerIds.join(',');

  // Reset to page 1 whenever a filter or the selected servers change so we
  // don't land on a stale/out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [mediaTypeFilter, requestedOnly, serverIdsKey]);

  const handleSortingChange = (newSorting: SortingState) => {
    setSorting(newSorting);
    setPage(1);
  };

  const sortColumnId = (sorting[0]?.id as SortableColumnId | undefined) ?? 'addedAt';
  const sortBy = columnToSortBy[sortColumnId] ?? 'added_at';
  const sortOrder: 'asc' | 'desc' = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : 'asc';
  const mediaTypeParam = mediaTypeFilter === 'all' ? undefined : mediaTypeFilter;
  // The stats endpoint only ever counts movies+shows (never 'artist'/music).
  // Scope the table's default stale-endpoint query the same way so the table
  // can never disagree with the stat cards - see CR-1.
  const mediaTypesParam: ('movie' | 'show')[] =
    mediaTypeFilter === 'all' ? ['movie', 'show'] : [mediaTypeFilter];

  // Check library status - fan out per server to detect which need setup
  const statusResult = useLibraryStatus(selectedServerIds);

  // Aggregate stats (totals, breakdowns, age distribution) for the current filter
  const stats = useLibraryNeverWatched(selectedServerIds, null, mediaTypeFilter);

  // Sourced only to read `configuredSources` - determines whether the
  // "Requested By" column needs a connector badge (both configured) or can
  // stay unlabeled (zero or one connector - the common case). Authenticated,
  // not owner-gated, so this is safe to call for every viewer of this page.
  const requesterStats = useRequesterStats(selectedServerIds);
  const showRequesterSource = Boolean(
    requesterStats.data?.configuredSources?.ombi && requesterStats.data?.configuredSources?.seerr
  );
  // The "Requested only" toggle is only meaningful when at least one request
  // connector is configured - with none configured every requestedBy is null
  // and the filter would always yield zero rows. Hide it entirely rather than
  // show a disabled control users would have to puzzle out (there's no single
  // good tooltip-length explanation, and the page already degrades this way
  // for the source badge above).
  const hasRequestConnector = Boolean(
    requesterStats.data?.configuredSources?.ombi || requesterStats.data?.configuredSources?.seerr
  );

  // Paginated, sortable item list
  const items = useLibraryStale(
    selectedServerIds,
    null,
    90, // staleDays is irrelevant for the never_watched category
    'never_watched',
    page,
    pageSize,
    mediaTypeParam,
    sortBy,
    sortOrder,
    mediaTypesParam,
    requestedOnly
  );

  const totalPages = Math.ceil((items.data?.pagination.total ?? 0) / pageSize) || 1;

  const columns = useMemo<ColumnDef<StaleItem>[]>(
    () => [
      {
        accessorKey: 'mediaType',
        header: t('common:labels.type'),
        enableSorting: false,
        cell: ({ row }) => <MediaTypeCell mediaType={row.original.mediaType} t={translate} />,
      },
      {
        accessorKey: 'title',
        header: t('library.neverWatched.colTitle'),
        cell: ({ row }) => (
          <span>
            <span className="font-medium">{row.original.title}</span>
            {row.original.year && (
              <span className="text-muted-foreground ml-1">({row.original.year})</span>
            )}
          </span>
        ),
      },
      ...(isMultiServer
        ? [
            {
              id: 'server',
              header: t('common:labels.server'),
              enableSorting: false,
              cell: ({ row }) => (
                <ServerColumnCell
                  server={{ id: row.original.serverId, name: row.original.serverName }}
                />
              ),
            } satisfies ColumnDef<StaleItem>,
          ]
        : []),
      {
        id: 'addedAt',
        accessorKey: 'addedAt',
        header: t('library.neverWatched.colAdded'),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {new Date(row.original.addedAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: 'daysStale',
        accessorKey: 'daysStale',
        header: t('library.neverWatched.colOnServer'),
        cell: ({ row }) => (
          <Badge variant="outline">{formatDuration(row.original.daysStale, translate)}</Badge>
        ),
      },
      {
        id: 'fileSize',
        accessorKey: 'fileSize',
        header: t('common:labels.size'),
        cell: ({ row }) => formatBytes(row.original.fileSize),
      },
      {
        id: 'requestedBy',
        header: t('library.neverWatched.colRequestedBy'),
        enableSorting: false,
        cell: ({ row }) => (
          <RequestedByCell
            requestedBy={row.original.requestedBy}
            t={translate}
            showSource={showRequesterSource}
          />
        ),
      },
    ],
    [t, translate, isMultiServer, showRequesterSource]
  );

  // Show empty state only if ALL selected servers need setup
  const allNeedSetup = useMemo(() => {
    if (statusResult.isLoading || selectedServerIds.length === 0) return false;
    return selectedServerIds.every((id) => {
      const s = statusResult.byServer.get(id)?.data;
      return !s?.isSynced || s.needsBackfill || s.isBackfillRunning;
    });
  }, [statusResult, selectedServerIds]);

  const refetchAll = () => {
    void stats.refetch();
    void items.refetch();
  };

  const bucketLabels: Record<NeverWatchedAgeBucket, string> = {
    lt30: t('library.neverWatched.bucketLt30'),
    d30to90: t('library.neverWatched.bucketD30to90'),
    d90to180: t('library.neverWatched.bucketD90to180'),
    d180to365: t('library.neverWatched.bucketD180to365'),
    gt365: t('library.neverWatched.bucketGt365'),
  };

  const oldestAddedAt = stats.data?.oldestAddedAt ?? null;
  const oldestDays = oldestAddedAt
    ? Math.floor((Date.now() - new Date(oldestAddedAt).getTime()) / 86_400_000)
    : null;

  const maxLibraryCount = Math.max(...(stats.data?.byLibrary.map((r) => r.count) ?? []), 1);

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.neverWatched.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.neverWatched.description')}</p>
    </div>
  );

  if (stats.isError || items.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.neverWatched.failedToLoad')}
          message={
            stats.error?.message ??
            items.error?.message ??
            t('library.neverWatched.failedToLoadDesc')
          }
          onRetry={refetchAll}
        />
      </div>
    );
  }

  if (allNeedSetup) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={refetchAll} />
      </div>
    );
  }

  // Only fall back to the full-page "everything watched" state when the
  // library-wide (unfiltered) totals are zero. On a filtered tab (Movies /
  // Series) a zero count only means that slice is empty - other media types
  // may still have never-watched items, so we must keep the tabs mounted and
  // let the per-section empty states (age chart, table) carry the filtered
  // zero instead of unmounting the tab switcher entirely - see CR-2.
  const isFullyLoaded = !stats.isLoading && !items.isLoading;
  if (isFullyLoaded && mediaTypeFilter === 'all' && (stats.data?.totals.count ?? 0) === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={EyeOff}
          title={t('library.neverWatched.emptyTitle')}
          description={t('library.neverWatched.emptyDesc')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {header}
        <div className="flex flex-wrap items-center gap-4">
          <Tabs
            value={mediaTypeFilter}
            onValueChange={(v) => setMediaTypeFilter(v as MediaTypeFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">{t('library.neverWatched.filterAll')}</TabsTrigger>
              <TabsTrigger value="movie">{t('library.neverWatched.filterMovies')}</TabsTrigger>
              <TabsTrigger value="show">{t('library.neverWatched.filterSeries')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {hasRequestConnector && (
            <div className="flex items-center gap-2">
              <Switch
                id="never-watched-requested-only"
                checked={requestedOnly}
                onCheckedChange={setRequestedOnly}
              />
              <Label htmlFor="never-watched-requested-only" className="font-normal">
                {t('library.neverWatched.requestedOnlyToggle')}
              </Label>
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={EyeOff}
          label={t('library.neverWatched.statCount')}
          value={stats.data?.totals.count ?? 0}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={HardDrive}
          label={t('library.neverWatched.statSize')}
          value={formatBytes(stats.data?.totals.sizeBytes)}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={Percent}
          label={t('library.neverWatched.statPct')}
          value={`${(stats.data?.totals.pctOfLibrary ?? 0).toFixed(1)}%`}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={CalendarClock}
          label={t('library.neverWatched.statOldest')}
          value={oldestAddedAt ? new Date(oldestAddedAt).toLocaleDateString() : '-'}
          subValue={
            oldestDays !== null
              ? t('library.neverWatched.onServerFor', {
                  duration: formatDuration(oldestDays, translate),
                })
              : t('library.neverWatched.noOldestData')
          }
          isLoading={stats.isLoading}
        />
      </div>

      {/* Age Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.neverWatched.ageDistribution')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            {t('library.neverWatched.ageDistributionDesc')}
          </p>
        </CardHeader>
        <CardContent>
          <NeverWatchedAgeChart
            data={stats.data?.ageDistribution}
            isLoading={stats.isLoading}
            height={250}
            bucketLabels={bucketLabels}
            seriesName={t('common:labels.items')}
            emptyTitle={t('library.neverWatched.ageChartEmptyTitle')}
            emptyDescription={
              mediaTypeFilter === 'all'
                ? t('library.neverWatched.ageChartEmptyDesc')
                : t('library.neverWatched.ageChartEmptyDescFiltered')
            }
          />
        </CardContent>
      </Card>

      {/* By Library Breakdown */}
      {stats.data && stats.data.byLibrary.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t('library.neverWatched.byLibrary')}
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              {t('library.neverWatched.byLibraryDesc')}
            </p>
          </CardHeader>
          <CardContent>
            <div className="divide-border divide-y rounded-md border">
              {stats.data.byLibrary.map((row) => {
                const widthPct = Math.max((row.count / maxLibraryCount) * 100, 4);
                // `libraryName` is actually the raw library key (a Plex library
                // id, or a Jellyfin/Emby GUID) - there's no human-readable
                // library display name in the DB. Prefix with the server name
                // when multiple servers are in play so two libraries never
                // render an identical label; label it explicitly as a library
                // key otherwise so we don't pass off a raw id as a real name.
                const libraryLabel = isMultiServer
                  ? `${row.serverName} · ${row.libraryName}`
                  : t('library.neverWatched.libraryKeyLabel', { id: row.libraryName });
                return (
                  <div
                    key={`${row.serverId}-${row.libraryId}`}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{libraryLabel}</span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {row.count} {t('common:labels.items').toLowerCase()} &middot;{' '}
                          {formatBytes(row.sizeBytes)}
                        </span>
                      </div>
                      <div className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
                        <div
                          className="bg-primary h-full rounded-full"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Items Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.neverWatched.itemsTitle')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t('library.neverWatched.itemsDesc')}</p>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={items.data?.items ?? []}
            isLoading={items.isLoading}
            pageCount={totalPages}
            page={page}
            onPageChange={setPage}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            isServerFiltered
            emptyMessage={
              requestedOnly
                ? t('library.neverWatched.requestedOnlyEmptyTitle')
                : t('library.neverWatched.emptyTitle')
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
