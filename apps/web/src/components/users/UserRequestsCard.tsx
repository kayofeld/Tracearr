import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Film, Tv, HardDrive, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { useRequesterStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatBytes } from '@/lib/formatters';

/** Rounded whole-number percentage, or null when the denominator is zero (never NaN/Infinity). */
function ratioPercent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : null;
}

interface UserRequestsCardProps {
  /** The profile's identity id (`fullData?.identity.userId`); matched against `RequesterStatsRow.userId`. */
  userId: string | null | undefined;
}

function formatDate(iso: string | null): string {
  return iso ? format(new Date(iso), 'MMM d, yyyy') : '-';
}

/**
 * Surfaces the proportion of this person's Ombi requests that went
 * unwatched, on their profile page - by count (of requests matched to the
 * library) and by size (of the storage those matched requests occupy), since
 * the two can diverge sharply. Sources the same GET /stats/requesters dataset
 * as the Requesters stats page and picks the row matching this profile's
 * identity id; no dedicated endpoint.
 */
export function UserRequestsCard({ userId }: UserRequestsCardProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds } = useServer();
  const stats = useRequesterStats(selectedServerIds);

  // Connector off: render nothing at all, not an empty card - every install
  // without Ombi configured must see zero change on this page.
  if (!stats.isLoading && stats.data && !stats.data.configured) {
    return null;
  }

  if (stats.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="h-5 w-5" />
            {t('pages:userDetail.requestsCard.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const row = userId
    ? (stats.data?.requesters.find((requester) => requester.userId === userId) ?? null)
    : null;

  // Denominator honesty: neverWatchedCount/totalSizeBytes/neverWatchedSizeBytes are all
  // computed over requests that matched a library item (matchedToLibraryCount), NOT over
  // every request row (requestCount includes pending/denied/unmatched requests that have no
  // watched state at all). Dividing by requestCount would understate the ratio whenever some
  // requests aren't in the library, so both percentages below use matchedToLibraryCount /
  // totalSizeBytes as their denominators, and the copy says "in your library" to make that
  // explicit rather than implying the ratio covers every request ever made.
  const pctByCount = row ? ratioPercent(row.neverWatchedCount, row.matchedToLibraryCount) : null;
  const pctBySize = row ? ratioPercent(row.neverWatchedSizeBytes, row.totalSizeBytes) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Film className="h-5 w-5" />
          {t('pages:userDetail.requestsCard.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!row ? (
          // A real, expected case: nothing in Ombi has been attributed to this
          // identity (yet). This is NOT the same as "requested nothing" - show
          // a neutral message, never zeroed stats that would imply that.
          <p className="text-muted-foreground text-sm">
            {t('pages:userDetail.requestsCard.notLinked')}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
                    <EyeOff className="h-4 w-4" />
                    {t('pages:userDetail.requestsCard.byCountLabel')}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {pctByCount !== null ? `${pctByCount}%` : '-'}
                  </span>
                </div>
                {pctByCount !== null && <Progress value={pctByCount} className="my-2 h-2" />}
                <p className="text-muted-foreground text-xs">
                  {row.matchedToLibraryCount > 0
                    ? t('pages:userDetail.requestsCard.byCountDetail', {
                        neverWatched: row.neverWatchedCount,
                        matched: row.matchedToLibraryCount,
                      })
                    : t('pages:userDetail.requestsCard.noLibraryMatch')}
                </p>
              </div>

              <div className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
                    <HardDrive className="h-4 w-4" />
                    {t('pages:userDetail.requestsCard.bySizeLabel')}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {pctBySize !== null ? `${pctBySize}%` : '-'}
                  </span>
                </div>
                {pctBySize !== null && <Progress value={pctBySize} className="my-2 h-2" />}
                <p className="text-muted-foreground text-xs">
                  {row.totalSizeBytes > 0
                    ? t('pages:userDetail.requestsCard.bySizeDetail', {
                        wasted: formatBytes(row.neverWatchedSizeBytes),
                        total: formatBytes(row.totalSizeBytes),
                      })
                    : t('pages:userDetail.requestsCard.noLibraryMatch')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground flex items-center gap-1">
                  <Film className="h-3 w-3" />
                  {t('pages:statsRequesters.colMovies')}
                </p>
                <p className="font-medium tabular-nums">{row.movieCount}</p>
              </div>
              <div>
                <p className="text-muted-foreground flex items-center gap-1">
                  <Tv className="h-3 w-3" />
                  {t('pages:statsRequesters.colTv')}
                </p>
                <p className="font-medium tabular-nums">{row.tvCount}</p>
              </div>
              <div>
                <p className="text-muted-foreground">
                  {t('pages:statsRequesters.colWatchedByRequester')}
                </p>
                <p className="font-medium tabular-nums">{row.watchedByRequesterCount}</p>
              </div>
            </div>

            {(row.firstRequestAt || row.lastRequestAt) && (
              <p className="text-muted-foreground text-xs">
                {t('pages:statsRequesters.colFirstRequest')}: {formatDate(row.firstRequestAt)}
                {' · '}
                {t('pages:statsRequesters.colLastRequest')}: {formatDate(row.lastRequestAt)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
