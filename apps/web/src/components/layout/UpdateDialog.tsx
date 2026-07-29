import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  ExternalLink,
  ArrowRight,
  Terminal,
  Package,
  Sparkles,
  Loader2,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { VersionInfo } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useUpdateCapability } from '@/hooks/queries';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: VersionInfo;
}

/** How many 3s poll ticks to wait for the version to change after triggering
 * a Docker redeploy before giving up and showing an honest terminal state
 * (~3 minutes). Exported for tests. */
export const DOCKER_UPDATE_POLL_MAX_ATTEMPTS = 60;

/**
 * Dialog showing update details including version info, type, and release notes
 */
export function UpdateDialog({ open, onOpenChange, version }: UpdateDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { current, latest } = version;

  // Self-update (bare-metal) or Portainer redeploy webhook (Docker). When
  // available, offer a one-click update instead of the manual docker/pull command.
  const { data: capability } = useUpdateCapability(open);
  const canSelfUpdate = capability?.available ?? false;
  const isDockerUpdate = capability?.isDocker ?? false;

  const [updating, setUpdating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [dockerPollTimedOut, setDockerPollTimedOut] = useState(false);

  // Poll update status + version while an update is running.
  //
  // Bare-metal: the server restarts in-place mid-update, so a dropped poll
  // means "restarting" and the `.update-status.json` file (read via
  // updateStatus()) carries real progress messages; a `failed` state is a
  // real error.
  //
  // Docker: the redeploy webhook recreates the container from *outside* this
  // process, so there is no progress to observe once it fires - the server
  // reports a fixed `state: 'unknown'` (see VersionUpdateStatus) rather than
  // erroring, and the connection itself may later drop once the container is
  // actually replaced (expected, not a failure). Keep polling only for the
  // version to change, and give up after DOCKER_UPDATE_POLL_MAX_ATTEMPTS
  // instead of spinning forever - the caller gets an honest "couldn't
  // confirm, refresh manually" state.
  useEffect(() => {
    if (!updating || !latest) return;
    let active = true;
    let attempts = 0;

    const tick = async () => {
      attempts += 1;
      const [status, ver] = await Promise.all([
        api.version.updateStatus().catch(() => null),
        api.version.get().catch(() => null),
      ]);
      if (!active) return;

      if (ver?.current.version === latest.version) {
        setStatusMsg(t('settings:update.updated', { version: latest.version }));
        setUpdating(false);
        clearInterval(timer);
        setTimeout(() => {
          window.location.reload();
        }, 1500);
        return;
      }

      if (isDockerUpdate) {
        // 'unknown' is the expected steady state here - the backend cannot
        // observe progress once the redeploy fires. A later connection drop
        // (ver/status both null) is expected too, once the container is
        // actually replaced. Either way: keep waiting, bounded.
        if (attempts >= DOCKER_UPDATE_POLL_MAX_ATTEMPTS) {
          setUpdating(false);
          setDockerPollTimedOut(true);
          clearInterval(timer);
          return;
        }
        setStatusMsg(status?.message ?? t('settings:update.dockerRestarting'));
        return;
      }

      if (status?.state === 'failed') {
        toast.error(status.message ?? t('settings:update.failed'));
        setUpdating(false);
        clearInterval(timer);
        return;
      }
      setStatusMsg(
        status?.message ?? (ver ? t('settings:update.inProgress') : t('settings:update.restarting'))
      );
    };
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [updating, latest, t, isDockerUpdate]);

  const handleSelfUpdate = useCallback(async () => {
    setUpdating(true);
    setDockerPollTimedOut(false);
    setStatusMsg(t('settings:update.inProgress'));
    try {
      const result = await api.version.update();
      // Docker's response carries a note explaining further progress can't
      // be observed from here (VersionUpdateStartResponse.note) - prefer it
      // over the generic "in progress" message.
      if (result.note) setStatusMsg(result.note);
    } catch (err) {
      if (isDockerUpdate) {
        // A network failure here can mean the container is already being
        // recreated - fall through to the polling "waiting to restart"
        // state instead of surfacing it as an error.
        return;
      }
      setUpdating(false);
      toast.error(err instanceof Error ? err.message : t('settings:update.failed'));
    }
  }, [t, isDockerUpdate]);

  // Determine update type label
  const updateType = useMemo(() => {
    if (!latest) return null;

    // Current is beta, latest is stable of same base version
    if (current.isPrerelease && !latest.isPrerelease) {
      return {
        label: t('settings:update.stableRelease'),
        variant: 'default' as const,
        icon: Sparkles,
      };
    }

    // Current is beta, latest is newer beta
    if (current.isPrerelease && latest.isPrerelease) {
      return {
        label: t('settings:update.betaUpdate'),
        variant: 'secondary' as const,
        icon: Package,
      };
    }

    // Current is stable, latest is newer stable
    return { label: t('settings:update.newVersion'), variant: 'default' as const, icon: Sparkles };
  }, [current, latest, t]);

  // Format the docker pull command
  const dockerCommand = useMemo(() => {
    if (!latest) return '';

    // Check if user is running supervised image (tag starts with "supervised-")
    const isSupervised = current.tag?.startsWith('supervised-') ?? false;

    // Determine the appropriate tag based on image type and release channel
    let tag: string;
    if (isSupervised) {
      tag = latest.isPrerelease ? 'supervised-next' : 'supervised';
    } else {
      tag = latest.isPrerelease ? 'next' : 'latest';
    }

    return `docker pull ghcr.io/connorgallopo/tracearr:${tag}`;
  }, [current.tag, latest]);

  if (!latest || !updateType) return null;

  const currentDisplay = current.tag ?? `v${current.version}`;
  const latestDisplay = latest.tag;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="flex items-center gap-2">
              <updateType.icon className="h-5 w-5 text-green-500" />
              {t('settings:update.title')}
            </DialogTitle>
            <Badge variant={updateType.variant} className="text-xs">
              {updateType.label}
            </Badge>
          </div>
          <DialogDescription className="flex items-center gap-2 pt-1">
            <span className="text-muted-foreground">{currentDisplay}</span>
            <ArrowRight className="text-muted-foreground h-3 w-3" />
            <span className="font-medium text-green-600 dark:text-green-400">{latestDisplay}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Release name if different from tag */}
          {latest.releaseName && latest.releaseName !== latest.tag && (
            <div className="text-sm font-medium">{latest.releaseName}</div>
          )}

          {/* Release notes */}
          {latest.releaseNotes && (
            <div className="space-y-2">
              <div className="text-foreground text-sm font-semibold">
                {t('settings:update.releaseNotes')}
              </div>
              <ScrollArea className="h-48 rounded-md border p-3">
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
                    {latest.releaseNotes}
                  </pre>
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Self-update / redeploy progress */}
          {canSelfUpdate && updating && (
            <div className="bg-muted flex items-center gap-2 rounded-md p-3 text-sm">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span>{statusMsg ?? t('settings:update.inProgress')}</span>
            </div>
          )}

          {/* Docker redeploy: honest terminal state once we give up waiting for the
              version to change - never spin forever on progress we can't receive. */}
          {canSelfUpdate && !updating && dockerPollTimedOut && (
            <div className="bg-muted flex items-center justify-between gap-3 rounded-md p-3 text-sm">
              <span>{t('settings:update.dockerTimedOut')}</span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('common:actions.refresh')}
              </Button>
            </div>
          )}

          {/* Manual docker/pull command (Docker deployments or when self-update is off) */}
          {!canSelfUpdate && (
            <div className="space-y-2">
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t('settings:update.updateCommand')}
              </div>
              <div className="bg-muted flex items-center gap-2 rounded-md p-3 font-mono text-sm">
                <Terminal className="text-muted-foreground h-4 w-4 shrink-0" />
                <code className="flex-1 select-all">{dockerCommand}</code>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('settings:update.pullInstructions')}
              </p>
              {/* Docker-only: offer the in-app update path once a redeploy
                  webhook is configured, instead of the manual pull command
                  above every time. */}
              {isDockerUpdate && (
                <p className="text-muted-foreground text-xs">
                  {capability?.dockerNote}{' '}
                  <Link
                    to="/settings/updates"
                    className="text-primary hover:underline"
                    onClick={() => onOpenChange(false)}
                  >
                    {t('settings:tabs.updates')}
                  </Link>
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updating}>
              {t('common:actions.later')}
            </Button>
            {canSelfUpdate && (
              <Button className="gap-2" onClick={handleSelfUpdate} disabled={updating}>
                {updating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('settings:update.updateNow')}
              </Button>
            )}
            <Button asChild className="gap-2">
              <a href={latest.releaseUrl} target="_blank" rel="noopener noreferrer">
                {t('common:actions.viewOnGithub')}
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
