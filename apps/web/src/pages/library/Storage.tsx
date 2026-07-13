import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, TrendingUp, Copy, Archive } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  ErrorState,
  LibraryEmptyState,
  // DuplicatesTable, // Temporarily hidden
  StaleContentTabs,
  RoiTable,
} from '@/components/library';
import { StoragePredictionChart } from '@/components/charts';
import { PerServerCardGrid } from '@/components/server';
import {
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryRoi,
  useLibraryStatus,
} from '@/hooks/queries';
import { useMultiServerQuery } from '@/hooks/useMultiServerQuery';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { formatBytes } from '@/lib/formatters';
import { api } from '@/lib/api';

export function LibraryStorage() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  // Check library status - fan out per server to detect which need setup
  const statusResult = useLibraryStatus(selectedServerIds);

  // Pagination state for tables
  const [duplicatesPage, _setDuplicatesPage] = useState(1);
  const [roiPage, setRoiPage] = useState(1);

  // Storage trend chart toggle
  const [showPredictions, setShowPredictions] = useState(true);

  // ROI sorting and filtering state - default to high ROI first
  const [roiSortBy, setRoiSortBy] = useState<
    'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title'
  >('watch_hours_per_gb');
  const [roiSortOrder, setRoiSortOrder] = useState<'asc' | 'desc'>('desc');
  const [roiMediaType, setRoiMediaType] = useState<'all' | 'movie' | 'show' | 'artist'>('all');

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

  // Fan out storage per server - storage endpoint is single-server only
  const storageMulti = useMultiServerQuery(selectedServerIds, (id) => ({
    queryKey: ['library', 'storage', id, undefined, apiPeriod],
    queryFn: () => api.library.storage(id, undefined, apiPeriod),
  }));

  // Combined KPI: sum totalSizeBytes across all servers (field is a string from BigInt serialization)
  const totalStorageBytes = useMemo(() => {
    let sum = 0;
    for (const id of selectedServerIds) {
      const entry = storageMulti.byServer.get(id);
      sum += Number(entry?.data?.current.totalSizeBytes ?? 0);
    }
    return sum;
  }, [storageMulti.byServer, selectedServerIds]);

  // Combined growth rate: sum bytesPerMonth; treat insufficient as 0 contribution
  const growthSummary = useMemo(() => {
    let totalBytes = 0;
    let allInsufficient = true;
    let hasAnyData = false;

    for (const id of selectedServerIds) {
      const data = storageMulti.byServer.get(id)?.data;
      if (!data) continue;
      hasAnyData = true;
      const insufficient =
        data.predictions.currentDataDays != null &&
        data.predictions.currentDataDays < (data.predictions.minDataDays ?? 7);
      if (!insufficient) {
        allInsufficient = false;
        totalBytes += Number(data.growthRate?.bytesPerMonth ?? 0);
      }
    }

    return { totalBytes, allInsufficient: !hasAnyData || allInsufficient };
  }, [storageMulti.byServer, selectedServerIds]);

  const growthRateDisplay = growthSummary.allInsufficient
    ? t('library.storage.insufficientData')
    : growthSummary.totalBytes > 0
      ? `+${formatBytes(growthSummary.totalBytes)}/mo`
      : t('library.storage.zeroGrowth');

  // For single-server: expose the underlying query result for chart + sub-value
  const singleStorageEntry =
    !isMultiServer && selectedServerIds.length === 1
      ? (storageMulti.byServer.get(selectedServerIds[0] ?? '') ?? null)
      : null;
  const singleInsufficient =
    singleStorageEntry?.data?.predictions.currentDataDays != null &&
    singleStorageEntry.data.predictions.currentDataDays <
      (singleStorageEntry.data.predictions.minDataDays ?? 7);
  const growthRateSubValue =
    !isMultiServer && singleInsufficient
      ? `${singleStorageEntry?.data?.predictions.currentDataDays} ${t('library.storage.of')} ${singleStorageEntry?.data?.predictions.minDataDays} ${t('library.storage.days')}`
      : undefined;

  // Combined cross-server duplicates - only relevant when multiple servers are selected
  const duplicates = useLibraryDuplicates(
    selectedServerIds,
    duplicatesPage,
    10,
    selectedServerIds.length > 1
  );

  // Combined stale summary for KPI card
  const staleSummary = useLibraryStale(selectedServerIds, null, 90, 'all', 1, 1);
  const staleCount =
    (staleSummary.data?.summary.neverWatched.count ?? 0) +
    (staleSummary.data?.summary.stale.count ?? 0);
  const staleSizeBytes =
    (staleSummary.data?.summary.neverWatched.sizeBytes ?? 0) +
    (staleSummary.data?.summary.stale.sizeBytes ?? 0);

  // Combined ROI - combined across servers via the backend
  const roi = useLibraryRoi(
    selectedServerIds,
    null,
    roiPage,
    10,
    roiMediaType === 'all' ? undefined : roiMediaType,
    roiSortBy,
    roiSortOrder
  );

  // All hooks must fire before any early returns
  const allStorageErrors = useMemo(() => {
    if (selectedServerIds.length === 0) return false;
    return selectedServerIds.every((id) => storageMulti.byServer.get(id)?.isError === true);
  }, [storageMulti.byServer, selectedServerIds]);

  const firstStorageError = useMemo(() => {
    for (const id of selectedServerIds) {
      const entry = storageMulti.byServer.get(id);
      if (entry?.isError) return entry.error;
    }
    return null;
  }, [storageMulti.byServer, selectedServerIds]);

  // Show empty state only if ALL selected servers need setup
  const allNeedSetup = useMemo(() => {
    if (statusResult.isLoading || selectedServerIds.length === 0) return false;
    return selectedServerIds.every((id) => {
      const s = statusResult.byServer.get(id)?.data;
      return !s?.isSynced || s.needsBackfill || s.isBackfillRunning;
    });
  }, [statusResult, selectedServerIds]);

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.storage.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.storage.description')}</p>
    </div>
  );

  if (allStorageErrors && firstStorageError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.storage.failedToLoad')}
          message={firstStorageError.message ?? t('library.storage.failedToLoadDesc')}
          onRetry={() => {
            for (const id of selectedServerIds) {
              void storageMulti.byServer.get(id)?.refetch();
            }
          }}
        />
      </div>
    );
  }

  if (allNeedSetup) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState
          onComplete={() => {
            for (const id of selectedServerIds) {
              void storageMulti.byServer.get(id)?.refetch();
            }
          }}
        />
      </div>
    );
  }

  // Confidence badge applies only in single-server mode
  const singleServerConfidence = singleStorageEntry?.data?.predictions.confidence;

  return (
    <div className="space-y-6">
      {header}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={HardDrive}
          label={t('library.storage.totalStorage')}
          value={formatBytes(totalStorageBytes)}
          isLoading={storageMulti.isLoading}
        />
        <StatCard
          icon={TrendingUp}
          label={t('library.storage.growthRate')}
          value={growthRateDisplay}
          subValue={growthRateSubValue}
          isLoading={storageMulti.isLoading}
        />
        {/* Duplicates KPI - only meaningful when multiple servers selected */}
        {selectedServerIds.length > 1 && (
          <StatCard
            icon={Copy}
            label={t('library.storage.duplicates')}
            value={`${duplicates.data?.summary.totalGroups ?? 0} ${t('library.storage.groups')}`}
            subValue={`${formatBytes(duplicates.data?.summary.totalPotentialSavingsBytes ?? 0)} ${t('library.storage.recoverable')}`}
            isLoading={duplicates.isLoading}
          />
        )}
        <StatCard
          icon={Archive}
          label={t('library.storage.staleContent')}
          value={`${staleCount} ${t('library.storage.items')}`}
          subValue={`${formatBytes(staleSizeBytes)} ${t('library.storage.unused')}`}
          isLoading={staleSummary.isLoading}
        />
      </div>

      {/* Storage Trend & Predictions Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base font-medium">
                {t('library.storage.storageTrend')}
              </CardTitle>
              {/* Confidence badge shown only in single-server mode */}
              {!isMultiServer && showPredictions && singleServerConfidence && (
                <Badge
                  variant={
                    singleServerConfidence === 'high'
                      ? 'success'
                      : singleServerConfidence === 'medium'
                        ? 'warning'
                        : 'secondary'
                  }
                >
                  {{
                    high: t('library.storage.confidenceHigh'),
                    medium: t('library.storage.confidenceMedium'),
                    low: t('library.storage.confidenceLow'),
                  }[singleServerConfidence] ?? singleServerConfidence}{' '}
                  {t('library.storage.confidence')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="show-predictions"
                  checked={showPredictions}
                  onCheckedChange={setShowPredictions}
                />
                <Label htmlFor="show-predictions" className="text-sm">
                  {t('library.storage.predictions')}
                </Label>
              </div>
              <TimeRangePicker value={timeRange} onChange={setTimeRange} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isMultiServer ? (
            /* Multi-server: one chart card per server */
            <PerServerCardGrid
              servers={selectedServers}
              renderServer={(server) => {
                const entry = storageMulti.byServer.get(server.id);
                return (
                  <StoragePredictionChart
                    data={entry?.data}
                    isLoading={entry?.isLoading ?? true}
                    height={250}
                    period={timeRange.period}
                    showPredictions={showPredictions}
                  />
                );
              }}
            />
          ) : (
            /* Single-server: original chart */
            <StoragePredictionChart
              data={singleStorageEntry?.data}
              isLoading={storageMulti.isLoading}
              height={300}
              period={timeRange.period}
              showPredictions={showPredictions}
            />
          )}
        </CardContent>
      </Card>

      {/* Duplicates Section - temporarily hidden globally
      {selectedServerIds.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Cross-Server Duplicates</CardTitle>
            <p className="text-muted-foreground text-sm">Content that exists on multiple servers</p>
          </CardHeader>
          <CardContent>
            <DuplicatesTable
              data={duplicates.data}
              isLoading={duplicates.isLoading}
              page={duplicatesPage}
              onPageChange={setDuplicatesPage}
            />
          </CardContent>
        </Card>
      )}
      */}

      {/* Stale Content Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.storage.staleContent')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t('library.storage.staleContentDesc')}</p>
        </CardHeader>
        <CardContent>
          <StaleContentTabs
            serverIds={selectedServerIds}
            libraryId={null}
            isMultiServer={isMultiServer}
            selectedServers={selectedServers}
          />
        </CardContent>
      </Card>

      {/* ROI Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-medium">
                {t('library.storage.contentROI')}
              </CardTitle>
              <p className="text-muted-foreground text-sm">{t('library.storage.contentROIDesc')}</p>
            </div>
            {roi.data?.summary && (
              <div className="text-right">
                <p className="text-2xl font-bold">
                  {roi.data.summary.avgWatchHoursPerGb.toFixed(2)}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('library.storage.avgHoursPerGB')}
                </p>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <RoiTable
            data={roi.data}
            isLoading={roi.isLoading}
            page={roiPage}
            onPageChange={(page) => setRoiPage(page)}
            sortBy={roiSortBy}
            sortOrder={roiSortOrder}
            onSortChange={(sb, so) => {
              setRoiSortBy(sb);
              setRoiSortOrder(so);
              setRoiPage(1); // Reset to first page when sort changes
            }}
            mediaType={roiMediaType}
            onMediaTypeChange={(mt) => {
              setRoiMediaType(mt);
              setRoiPage(1); // Reset to first page when filter changes
            }}
            isMultiServer={isMultiServer}
            selectedServers={selectedServers}
          />
        </CardContent>
      </Card>
    </div>
  );
}
