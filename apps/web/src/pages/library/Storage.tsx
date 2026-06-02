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
import {
  useLibraryStorage,
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryRoi,
  useLibraryStatus,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { formatBytes } from '@/lib/formatters';

export function LibraryStorage() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerId, servers } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  // Check library status first (single-server context; wraps id into array for hook)
  const statusResult = useLibraryStatus(selectedServerId ? [selectedServerId] : []);
  const status = {
    isLoading: statusResult.isLoading,
    data: selectedServerId ? statusResult.byServer.get(selectedServerId)?.data : undefined,
  };

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

  // Core data hooks - use time range for storage trends
  const storage = useLibraryStorage(selectedServerId, null, apiPeriod);
  // Only fetch duplicates when multiple servers exist (cross-server feature)
  const hasMultipleServers = servers.length > 1;
  const duplicates = useLibraryDuplicates(selectedServerId, duplicatesPage, 10, hasMultipleServers);
  const roi = useLibraryRoi(
    selectedServerId,
    null,
    roiPage,
    10,
    roiMediaType === 'all' ? undefined : roiMediaType,
    roiSortBy,
    roiSortOrder
  );

  // Fetch stale summary for KPI card (minimal page size since we only need summary)
  const staleSummary = useLibraryStale(selectedServerId, null, 90, 'all', 1, 1);
  const staleCount =
    (staleSummary.data?.summary.neverWatched.count ?? 0) +
    (staleSummary.data?.summary.stale.count ?? 0);
  const staleSizeBytes =
    (staleSummary.data?.summary.neverWatched.sizeBytes ?? 0) +
    (staleSummary.data?.summary.stale.sizeBytes ?? 0);

  // Growth rate display - show "0 GB/mo" for zero/negative/NaN growth
  const insufficientData =
    storage.data?.predictions.currentDataDays &&
    storage.data.predictions.currentDataDays < (storage.data.predictions.minDataDays ?? 7);
  const growthBytes = Number(storage.data?.growthRate?.bytesPerMonth ?? 0);
  const growthRateDisplay = insufficientData
    ? t('library.storage.insufficientData')
    : growthBytes > 0
      ? `+${formatBytes(storage.data?.growthRate.bytesPerMonth)}/mo`
      : t('library.storage.zeroGrowth');
  const growthRateSubValue = insufficientData
    ? `${storage.data?.predictions.currentDataDays} ${t('library.storage.of')} ${storage.data?.predictions.minDataDays} ${t('library.storage.days')}`
    : undefined;

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.storage.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.storage.description')}</p>
    </div>
  );

  // Show error state with retry
  if (storage.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.storage.failedToLoad')}
          message={storage.error?.message ?? t('library.storage.failedToLoadDesc')}
          onRetry={storage.refetch}
        />
      </div>
    );
  }

  // Show empty state if library not synced or needs backfill
  const needsSetup =
    !status.isLoading &&
    (!status.data?.isSynced || status.data?.needsBackfill || status.data?.isBackfillRunning);
  if (needsSetup) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={storage.refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={HardDrive}
          label={t('library.storage.totalStorage')}
          value={formatBytes(storage.data?.current.totalSizeBytes)}
          isLoading={storage.isLoading}
        />
        <StatCard
          icon={TrendingUp}
          label={t('library.storage.growthRate')}
          value={growthRateDisplay}
          subValue={growthRateSubValue}
          isLoading={storage.isLoading}
        />
        <StatCard
          icon={Copy}
          label={t('library.storage.duplicates')}
          value={`${duplicates.data?.summary.totalGroups ?? 0} ${t('library.storage.groups')}`}
          subValue={`${formatBytes(duplicates.data?.summary.totalPotentialSavingsBytes ?? 0)} ${t('library.storage.recoverable')}`}
          isLoading={duplicates.isLoading}
        />
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
              {showPredictions && storage.data?.predictions.confidence && (
                <Badge
                  variant={
                    storage.data.predictions.confidence === 'high'
                      ? 'success'
                      : storage.data.predictions.confidence === 'medium'
                        ? 'warning'
                        : 'secondary'
                  }
                >
                  {{
                    high: t('library.storage.confidenceHigh'),
                    medium: t('library.storage.confidenceMedium'),
                    low: t('library.storage.confidenceLow'),
                  }[storage.data.predictions.confidence] ??
                    storage.data.predictions.confidence}{' '}
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
          <StoragePredictionChart
            data={storage.data}
            isLoading={storage.isLoading}
            height={300}
            period={timeRange.period}
            showPredictions={showPredictions}
          />
        </CardContent>
      </Card>

      {/* Duplicates Section - temporarily hidden globally
      {hasMultipleServers && (
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
          <StaleContentTabs serverId={selectedServerId} libraryId={null} />
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
            onSortChange={(sortBy, sortOrder) => {
              setRoiSortBy(sortBy);
              setRoiSortOrder(sortOrder);
              setRoiPage(1); // Reset to first page when sort changes
            }}
            mediaType={roiMediaType}
            onMediaTypeChange={(mediaType) => {
              setRoiMediaType(mediaType);
              setRoiPage(1); // Reset to first page when filter changes
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
