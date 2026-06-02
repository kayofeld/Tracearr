import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Tv } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ErrorState,
  LibraryEmptyState,
  CodecDistributionSection,
  ResolutionDistributionSection,
} from '@/components/library';
import { QualityTimelineChart } from '@/components/charts';
import { useLibraryQuality, useLibraryStatus } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

type MediaTypeFilter = 'all' | 'movies' | 'shows';

export function LibraryQuality() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerId } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();
  const [mediaType, setMediaType] = useState<MediaTypeFilter>('all');

  // Check library status first (single-server context; wraps id into array for hook)
  const statusResult = useLibraryStatus(selectedServerId ? [selectedServerId] : []);
  const status = {
    isLoading: statusResult.isLoading,
    data: selectedServerId ? statusResult.byServer.get(selectedServerId)?.data : undefined,
  };

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

  const quality = useLibraryQuality(selectedServerId ?? undefined, apiPeriod, mediaType);

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.quality.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.quality.description')}</p>
    </div>
  );

  // Show error state with retry
  if (quality.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.quality.failedToLoad')}
          message={quality.error?.message ?? t('library.quality.failedToLoadDesc')}
          onRetry={quality.refetch}
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
        <LibraryEmptyState onComplete={quality.refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Quality Evolution Chart (full width) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <CardTitle className="text-base font-medium">
                {t('library.quality.qualityEvolution')}
              </CardTitle>
              <Tabs value={mediaType} onValueChange={(v) => setMediaType(v as MediaTypeFilter)}>
                <TabsList className="h-8">
                  <TabsTrigger value="all" className="h-7 px-3 text-xs">
                    {t('library.quality.all')}
                  </TabsTrigger>
                  <TabsTrigger value="movies" className="h-7 gap-1 px-3 text-xs">
                    <Film className="h-3 w-3" />
                    {t('common:media.movie_plural')}
                  </TabsTrigger>
                  <TabsTrigger value="shows" className="h-7 gap-1 px-3 text-xs">
                    <Tv className="h-3 w-3" />
                    {t('common:media.tv')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          </div>
        </CardHeader>
        <CardContent>
          <QualityTimelineChart
            data={quality.data}
            isLoading={quality.isLoading}
            height={300}
            period={timeRange.period}
          />
        </CardContent>
      </Card>

      {/* Resolution Distribution - Movies vs TV */}
      <ResolutionDistributionSection serverId={selectedServerId} />

      {/* Codec Distribution - Full width with tabs */}
      <CodecDistributionSection serverId={selectedServerId} />
    </div>
  );
}
