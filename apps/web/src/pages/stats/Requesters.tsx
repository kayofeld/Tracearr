import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ColumnDef } from '@tanstack/react-table';
import type { RequesterStatsRow } from '@tracearr/shared';
import { Users, Film, Tv, HardDrive, UserX, Settings as SettingsIcon, EyeOff } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState } from '@/components/library/ErrorState';
import { useRequesterStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatBytes } from '@/lib/formatters';

type MediaTypeFilter = 'all' | 'movie' | 'tv';

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '-';
}

/**
 * Which request connector(s) are configured, driving the copy on this page.
 * `RequesterStatsResponse.configuredSources` is optional (absent on an older
 * server that predates the Seerr connector) - treat that as 'unknown' and
 * fall back to source-neutral copy rather than guessing which one it is.
 */
type SourceKind = 'ombi' | 'seerr' | 'both' | 'unknown';

function sourceKind(configuredSources: { ombi: boolean; seerr: boolean } | undefined): SourceKind {
  if (!configuredSources) return 'unknown';
  const { ombi, seerr } = configuredSources;
  if (ombi && seerr) return 'both';
  if (ombi) return 'ombi';
  if (seerr) return 'seerr';
  return 'unknown';
}

export function StatsRequesters() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds } = useServer();
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all');

  const stats = useRequesterStats(selectedServerIds, mediaTypeFilter);
  const kind = sourceKind(stats.data?.configuredSources);
  const descriptionKey =
    kind === 'ombi'
      ? 'statsRequesters.descriptionOmbi'
      : kind === 'seerr'
        ? 'statsRequesters.descriptionSeerr'
        : 'statsRequesters.descriptionBoth';
  const unattributedRowDescKey =
    kind === 'ombi'
      ? 'statsRequesters.unattributedRowDescOmbi'
      : kind === 'seerr'
        ? 'statsRequesters.unattributedRowDescSeerr'
        : 'statsRequesters.unattributedRowDescBoth';

  const columns = useMemo<ColumnDef<RequesterStatsRow>[]>(
    () => [
      {
        accessorKey: 'username',
        header: t('statsRequesters.colRequester'),
        cell: ({ row }) => {
          const { userId, username } = row.original;
          if (userId) {
            return (
              <Link to={`/users/${userId}`} className="font-medium hover:underline">
                {username ?? t('common:labels.unknown')}
              </Link>
            );
          }
          return <span className="font-medium">{username ?? t('common:labels.unknown')}</span>;
        },
      },
      {
        accessorKey: 'requestCount',
        header: t('statsRequesters.colRequests'),
        cell: ({ row }) => <span className="tabular-nums">{row.original.requestCount}</span>,
      },
      {
        accessorKey: 'movieCount',
        header: t('statsRequesters.colMovies'),
        meta: { headerClassName: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.movieCount}</span>,
      },
      {
        accessorKey: 'tvCount',
        header: t('statsRequesters.colTv'),
        meta: { headerClassName: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.tvCount}</span>,
      },
      {
        accessorKey: 'neverWatchedCount',
        header: t('statsRequesters.colNeverWatched'),
        cell: ({ row }) =>
          row.original.neverWatchedCount > 0 ? (
            <Badge variant="warning">{row.original.neverWatchedCount}</Badge>
          ) : (
            <span className="text-muted-foreground">0</span>
          ),
      },
      {
        accessorKey: 'neverWatchedSizeBytes',
        header: t('statsRequesters.colWastedSize'),
        cell: ({ row }) => formatBytes(row.original.neverWatchedSizeBytes),
      },
      {
        accessorKey: 'watchedByRequesterCount',
        header: t('statsRequesters.colWatchedByRequester'),
        meta: { headerClassName: 'hidden md:table-cell', cellClassName: 'hidden md:table-cell' },
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.watchedByRequesterCount}</span>
        ),
      },
      {
        accessorKey: 'lastRequestAt',
        header: t('statsRequesters.colLastRequest'),
        meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell' },
        cell: ({ row }) => (
          <span className="text-muted-foreground">{formatDate(row.original.lastRequestAt)}</span>
        ),
      },
    ],
    [t]
  );

  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('statsRequesters.title')}</h1>
      <p className="text-muted-foreground text-sm">{t(descriptionKey)}</p>
    </div>
  );

  if (stats.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('statsRequesters.failedToLoad')}
          message={stats.error?.message ?? t('statsRequesters.failedToLoadDesc')}
          onRetry={() => void stats.refetch()}
        />
      </div>
    );
  }

  // The connector is off - this is a normal, expected state, not an error.
  if (!stats.isLoading && stats.data && !stats.data.configured) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-12 text-center">
          <Users className="text-muted-foreground/50 h-16 w-16" />
          <div>
            <h3 className="text-lg font-semibold">{t('statsRequesters.notConfiguredTitle')}</h3>
            <p className="text-muted-foreground mt-1">{t('statsRequesters.notConfiguredDesc')}</p>
          </div>
          {/* Neither connector is configured - offer both, never assume which one
              the owner will pick (this page has no way to know). */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link to="/settings/ombi">
                <SettingsIcon className="mr-2 h-4 w-4" />
                {t('statsRequesters.goToOmbiSettings')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/settings/seerr">
                <SettingsIcon className="mr-2 h-4 w-4" />
                {t('statsRequesters.goToSeerrSettings')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const totals = stats.data?.totals;
  const unattributed = stats.data?.unattributed;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {header}
        <Tabs
          value={mediaTypeFilter}
          onValueChange={(v) => setMediaTypeFilter(v as MediaTypeFilter)}
        >
          <TabsList>
            <TabsTrigger value="all">{t('statsRequesters.filterAll')}</TabsTrigger>
            <TabsTrigger value="movie">{t('statsRequesters.filterMovies')}</TabsTrigger>
            <TabsTrigger value="tv">{t('statsRequesters.filterTv')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Film}
          label={t('statsRequesters.statTotalRequests')}
          value={totals?.requestCount ?? 0}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={Users}
          label={t('statsRequesters.statRequesters')}
          value={totals?.requesterCount ?? 0}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={UserX}
          label={t('statsRequesters.statUnattributed')}
          value={totals?.unattributedCount ?? 0}
          isLoading={stats.isLoading}
        />
        <StatCard
          icon={HardDrive}
          label={t('statsRequesters.statNeverWatchedSize')}
          value={formatBytes(totals?.neverWatchedSizeBytes)}
          isLoading={stats.isLoading}
        />
      </div>

      {/* Unattributed bucket - always shown explicitly, never folded into the
          table silently, per the contract (RequesterStatsResponse.unattributed
          is always present, zeroed when empty). */}
      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <UserX className="text-muted-foreground h-4 w-4" />
            {t('statsRequesters.unattributedRow')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t(unattributedRowDescKey)}</p>
        </CardHeader>
        <CardContent>
          {stats.isLoading ? (
            <span className="text-muted-foreground text-sm">…</span>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <p className="text-muted-foreground">{t('statsRequesters.colRequests')}</p>
                <p className="font-medium tabular-nums">{unattributed?.requestCount ?? 0}</p>
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-muted-foreground flex items-center gap-1">
                    <Film className="h-3 w-3" />
                    {t('statsRequesters.colMovies')}
                  </p>
                  <p className="font-medium tabular-nums">{unattributed?.movieCount ?? 0}</p>
                </div>
                <div>
                  <p className="text-muted-foreground flex items-center gap-1">
                    <Tv className="h-3 w-3" />
                    {t('statsRequesters.colTv')}
                  </p>
                  <p className="font-medium tabular-nums">{unattributed?.tvCount ?? 0}</p>
                </div>
              </div>
              <div>
                <p className="text-muted-foreground flex items-center gap-1">
                  <EyeOff className="h-3 w-3" />
                  {t('statsRequesters.colNeverWatched')}
                </p>
                <p className="font-medium tabular-nums">{unattributed?.neverWatchedCount ?? 0}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t('statsRequesters.colWastedSize')}</p>
                <p className="font-medium">{formatBytes(unattributed?.neverWatchedSizeBytes)}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* By-requester table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">{t('statsRequesters.tableTitle')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('statsRequesters.tableDesc')}</p>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={stats.data?.requesters ?? []}
            isLoading={stats.isLoading}
            pageSize={20}
            emptyMessage={t('statsRequesters.noData')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
