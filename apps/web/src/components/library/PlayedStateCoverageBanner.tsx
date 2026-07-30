import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { PlayedStateCoverage } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface PlayedStateCoverageBannerProps {
  /**
   * Coverage object from a NeverWatchedStatsResponse/StaleResponse.
   *
   * `undefined` means "coverage unknown" - a cached pre-upgrade payload can
   * omit this field for up to one Redis cache TTL (ADR 0011) - and must NOT
   * be treated as "no coverage". Only an explicit `{ full: false, ... }`
   * payload renders a banner; `undefined` and `{ full: true }` both render
   * nothing.
   */
  coverage: PlayedStateCoverage | undefined;
}

/**
 * Page-level banner naming the servers without full played-state coverage
 * (ADR 0011, docs/architecture/emby-played-state-sync.md §7.7).
 *
 * A server counts as "uncovered" when it either can never gain coverage
 * (Plex, `capability === 'unsupported'`) or simply hasn't completed a sync
 * yet (`lastSyncedAt === null`). The two are worded differently: the first
 * is a permanent platform limitation, the second is transient and will
 * resolve once the (automatic, 12h-scheduled) sync completes.
 */
export function PlayedStateCoverageBanner({ coverage }: PlayedStateCoverageBannerProps) {
  const { t } = useTranslation('pages');

  if (!coverage || coverage.full) return null;

  const uncovered = coverage.servers.filter(
    (s) => s.capability === 'unsupported' || s.lastSyncedAt === null
  );
  if (uncovered.length === 0) return null;

  const unsupported = uncovered.filter((s) => s.capability === 'unsupported');
  const pending = uncovered.filter((s) => s.capability !== 'unsupported');

  const unsupportedNames = unsupported.map((s) => s.serverName).join(', ');
  const pendingNames = pending.map((s) => s.serverName).join(', ');

  let message: string;
  if (unsupported.length > 0 && pending.length > 0) {
    message = t('library.playedStateCoverage.bannerMixed', {
      unsupportedServers: unsupportedNames,
      pendingServers: pendingNames,
    });
  } else if (unsupported.length > 0) {
    message = t('library.playedStateCoverage.bannerUnsupported', { servers: unsupportedNames });
  } else {
    message = t('library.playedStateCoverage.bannerPending', { servers: pendingNames });
  }

  return (
    <Alert variant="warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t('library.playedStateCoverage.bannerTitle')}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <p className="mt-1">{t('library.playedStateCoverage.bannerNote')}</p>
      </AlertDescription>
    </Alert>
  );
}
