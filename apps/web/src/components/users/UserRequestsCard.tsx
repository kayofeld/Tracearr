import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Film, Tv, HardDrive, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRequesterStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatBytes } from '@/lib/formatters';

interface UserRequestsCardProps {
  /** The profile's identity id (`fullData?.identity.userId`); matched against `RequesterStatsRow.userId`. */
  userId: string | null | undefined;
}

function formatDate(iso: string | null): string {
  return iso ? format(new Date(iso), 'MMM d, yyyy') : '-';
}

/**
 * Surfaces this person's Ombi "wasted usage" - requests never watched by
 * anyone, and the storage they occupy - on their profile page. Sources the
 * same GET /stats/requesters dataset as the Requesters stats page and picks
 * the row matching this profile's identity id; no dedicated endpoint.
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
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div className="bg-primary/10 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full">
                <HardDrive className="text-primary h-4 w-4" />
              </div>
              <div>
                <p className="text-2xl font-bold">{formatBytes(row.neverWatchedSizeBytes)}</p>
                <p className="text-muted-foreground text-sm">
                  {t('pages:userDetail.requestsCard.neverWatchedOf', {
                    count: row.requestCount,
                    neverWatched: row.neverWatchedCount,
                  })}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
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
                <p className="text-muted-foreground flex items-center gap-1">
                  <EyeOff className="h-3 w-3" />
                  {t('pages:statsRequesters.colNeverWatched')}
                </p>
                <p className="font-medium tabular-nums">{row.neverWatchedCount}</p>
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
