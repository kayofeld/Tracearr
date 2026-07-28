import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Ticket, CheckCircle2, XCircle, Loader2, Trash2, Users, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { WS_EVENTS } from '@tracearr/shared';
import type { SeerrRequesterMapping, SeerrSyncProgressEvent } from '@tracearr/shared';
import {
  useSettings,
  useUpdateSettings,
  useSeerrStatus,
  useSeerrMappings,
  useSeerrSync,
  useSeerrPurge,
  useUpsertSeerrMapping,
  useRevertSeerrMapping,
  useUsers,
} from '@/hooks/queries';
import { formatDistanceToNow } from 'date-fns';

const UNATTRIBUTED_VALUE = '__unattributed__';

// A narrowed callable shape for `t()` - the real TFunction's generic overloads
// make it awkward to pass around as a parameter type (mirrors the same
// narrowing used in OmbiSettings.tsx / NeverWatched.tsx).
type Translate = (key: string, options?: Record<string, unknown>) => string;

function resolutionBadge(
  mapping: SeerrRequesterMapping,
  t: Translate
): { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' } {
  switch (mapping.resolution.type) {
    case 'manual':
      return { label: t('settings:seerr.resolutionManual'), variant: 'secondary' };
    case 'provider':
    case 'username':
      return { label: t('settings:seerr.resolutionProvider'), variant: 'success' };
    case 'unattributed':
    default:
      return { label: t('settings:seerr.resolutionUnattributed'), variant: 'outline' };
  }
}

/**
 * Requester mapping management dialog - deliberately sorts ambiguous/unattributed
 * to the top. Seerr resolves on a stable external id (jellyfinUserId/plexId), so
 * most rows should already be provider-matched - this sort makes the exceptions
 * (ambiguous multi-candidate ids, or requesters that never matched at all) obvious.
 */
function MappingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t: rawT } = useTranslation(['settings', 'common']);
  const t = rawT as unknown as Translate;
  const mappings = useSeerrMappings(open);
  const users = useUsers({ pageSize: 100 });
  const upsertMapping = useUpsertSeerrMapping();
  const revertMapping = useRevertSeerrMapping();

  // De-duplicate the roster by identity (userId) - a merged/multi-server user
  // otherwise appears once per server account.
  const identities = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of users.data?.data ?? []) {
      if (!seen.has(u.userId)) seen.set(u.userId, u.identityName ?? u.username);
    }
    return Array.from(seen, ([userId, label]) => ({ userId, label }));
  }, [users.data]);

  const rows = useMemo(() => {
    const list = mappings.data?.requesters ?? [];
    // Ambiguous first, then unattributed, then everything else - this is the
    // whole point of the screen: unmatched requesters must be obvious.
    const rank = (m: SeerrRequesterMapping) =>
      m.ambiguous ? 0 : m.resolution.type === 'unattributed' ? 1 : 2;
    return [...list].sort((a, b) => rank(a) - rank(b) || b.requestCount - a.requestCount);
  }, [mappings.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settings:seerr.mappingsTitle')}</DialogTitle>
          <DialogDescription>{t('settings:seerr.mappingsDescription')}</DialogDescription>
        </DialogHeader>

        {mappings.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
            <Users className="text-muted-foreground h-5 w-5" />
            <p className="text-muted-foreground text-sm">{t('settings:seerr.mappingsEmpty')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings:seerr.colRequester')}</TableHead>
                <TableHead>{t('settings:seerr.colRequests')}</TableHead>
                <TableHead>{t('settings:seerr.colResolution')}</TableHead>
                <TableHead>{t('settings:seerr.colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((mapping) => {
                const badge = resolutionBadge(mapping, t);
                const selectValue =
                  mapping.resolution.type === 'manual'
                    ? (mapping.resolution.userId ?? UNATTRIBUTED_VALUE)
                    : '';
                return (
                  <TableRow key={mapping.seerrUserId}>
                    <TableCell>
                      <div className="font-medium">
                        {mapping.seerrDisplayName ?? mapping.seerrUsername}
                      </div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {mapping.ambiguous && (
                          <Badge variant="warning">{t('settings:seerr.ambiguousBadge')}</Badge>
                        )}
                        {mapping.stale && (
                          <Badge variant="outline">{t('settings:seerr.staleBadge')}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{mapping.requestCount}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-2">
                        {mapping.suggestions.length > 0 && mapping.resolution.type !== 'manual' && (
                          <div className="flex flex-wrap items-center gap-1 text-xs">
                            <span className="text-muted-foreground">
                              {t('settings:seerr.suggestions')}
                            </span>
                            {mapping.suggestions.map((s) => (
                              <Button
                                key={s.userId}
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs"
                                onClick={() =>
                                  upsertMapping.mutate({
                                    seerrUserId: mapping.seerrUserId,
                                    data: { userId: s.userId },
                                  })
                                }
                              >
                                {s.username}
                              </Button>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Select
                            value={selectValue}
                            onValueChange={(value) =>
                              upsertMapping.mutate({
                                seerrUserId: mapping.seerrUserId,
                                data: { userId: value === UNATTRIBUTED_VALUE ? null : value },
                              })
                            }
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue placeholder={t('settings:seerr.assignPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNATTRIBUTED_VALUE}>
                                {t('settings:seerr.forceUnattributed')}
                              </SelectItem>
                              {identities.map((identity) => (
                                <SelectItem key={identity.userId} value={identity.userId}>
                                  {identity.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {mapping.resolution.type === 'manual' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => revertMapping.mutate(mapping.seerrUserId)}
                            >
                              {t('settings:seerr.revertToAutomatic')}
                            </Button>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SeerrSettings() {
  const { t } = useTranslation(['settings', 'notifications', 'common']);
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  const [seerrUrl, setSeerrUrl] = useState('');
  const [seerrApiKey, setSeerrApiKey] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [syncPhase, setSyncPhase] = useState<SeerrSyncProgressEvent | null>(null);
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeResult, setPurgeResult] = useState<{ requests: number; mappings: number } | null>(
    null
  );

  const status = useSeerrStatus();
  const syncNow = useSeerrSync();
  const purge = useSeerrPurge();

  useEffect(() => {
    if (settings) {
      setSeerrUrl(settings.seerrUrl ?? '');
      setSeerrApiKey(settings.seerrApiKey ?? '');
    }
  }, [settings]);

  // Live sync progress - mirrors the Ombi/library-sync WS pattern (see useSocket.tsx).
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: SeerrSyncProgressEvent) => {
      setSyncPhase(progress);
      if (progress.phase === 'done' || progress.phase === 'error') {
        void status.refetch();
      }
    };

    socket.on(WS_EVENTS.SEERR_SYNC_PROGRESS, handleProgress);
    return () => {
      socket.off(WS_EVENTS.SEERR_SYNC_PROGRESS, handleProgress);
    };
  }, [socket, status]);

  const handleTestConnection = async () => {
    if (!seerrUrl || !seerrApiKey) {
      setConnectionStatus('error');
      setConnectionMessage(t('settings:seerr.pleaseEnterDetails'));
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage(t('settings:seerr.testingConnection'));

    try {
      const result = await api.seerr.testConnection({ url: seerrUrl, apiKey: seerrApiKey });
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(
          t('settings:seerr.connectedFound', {
            version: result.version ?? '?',
            count: result.userCount ?? 0,
          })
        );
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.error || t('settings:seerr.connectionFailed'));
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(
        err instanceof Error ? err.message : t('settings:seerr.connectionFailed')
      );
    }
  };

  const handleSave = () => {
    const willBeConfigured = Boolean(seerrUrl) && Boolean(seerrApiKey);
    // The repeatable sync runs every 6h, so without this a freshly configured
    // connector would show nothing until the next scheduled run and read as broken.
    // Kick off one sync on the transition into "configured". Derive `wasConfigured`
    // from the loaded `settings` (not `status`, which can still be loading/stale
    // when this fires and would then wrongly treat an already-configured connector
    // as unconfigured, firing a redundant sync) - settings are guaranteed loaded
    // here by the `settingsLoading` gate and are the same source the form
    // initializes from. Pass `silent: true` so a 409 (a scheduled sync already
    // running) doesn't surface as an error toast right after a successful save.
    const wasConfigured = Boolean(settings?.seerrUrl && settings?.seerrApiKey);
    updateSettings.mutate(
      {
        seerrUrl: seerrUrl || null,
        seerrApiKey: seerrApiKey || null,
      },
      {
        onSuccess: () => {
          if (willBeConfigured && !wasConfigured) {
            setSyncPhase(null);
            syncNow.mutate({ silent: true });
          }
        },
      }
    );
  };

  const handleSyncNow = () => {
    setSyncPhase(null);
    syncNow.mutate({});
  };

  const handlePurgeConfirm = async () => {
    try {
      const result = await purge.mutateAsync();
      setPurgeResult({ requests: result.deletedRequests, mappings: result.deletedMappings });
      setPurgeConfirmOpen(false);
    } catch {
      // useSeerrPurge already toasts the failure; keep the dialog open so the
      // owner can retry.
    }
  };

  if (settingsLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const s = status.data;
  const isSyncing =
    syncNow.isPending ||
    s?.running ||
    (syncPhase && syncPhase.phase !== 'done' && syncPhase.phase !== 'error');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ticket className="h-5 w-5" />
            {t('settings:seerr.title')}
          </CardTitle>
          <CardDescription>{t('settings:seerr.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="seerrUrl">{t('settings:seerr.url')}</Label>
              <Input
                id="seerrUrl"
                placeholder={t('settings:seerr.urlPlaceholder')}
                value={seerrUrl}
                onChange={(e) => setSeerrUrl(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('settings:seerr.urlHelp')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="seerrApiKey">{t('common:labels.apiKey')}</Label>
              <PasswordInput
                id="seerrApiKey"
                value={seerrApiKey}
                onChange={(e) => setSeerrApiKey(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('settings:seerr.apiKeyHelp')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => void handleTestConnection()}
                disabled={connectionStatus === 'testing' || !seerrUrl || !seerrApiKey}
                variant="outline"
              >
                {connectionStatus === 'testing' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('import.testing')}
                  </>
                ) : (
                  t('servers.testConnection')
                )}
              </Button>
              <Button onClick={handleSave} disabled={updateSettings.isPending}>
                {updateSettings.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {t('common:actions.save')}
              </Button>

              {connectionStatus === 'success' && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {connectionMessage}
                </span>
              )}
              {connectionStatus === 'error' && (
                <span className="text-destructive flex items-center gap-1 text-sm">
                  <XCircle className="h-4 w-4" />
                  {connectionMessage}
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{t('settings:seerr.statusTitle')}</CardTitle>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setMappingsOpen(true)}>
                <Users className="mr-1.5 h-3.5 w-3.5" />
                {t('settings:seerr.manageMappings')}
              </Button>
              <Button
                size="sm"
                onClick={handleSyncNow}
                disabled={!s?.configured || Boolean(isSyncing)}
              >
                {isSyncing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {isSyncing ? t('settings:seerr.syncing') : t('settings:seerr.syncNow')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !s?.configured ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="font-medium">{t('settings:seerr.notConfigured')}</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('settings:seerr.notConfiguredDesc')}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground">{t('settings:seerr.lastRun')}</p>
                  <p className="font-medium">
                    {s.lastRunAt
                      ? formatDistanceToNow(new Date(s.lastRunAt), { addSuffix: true })
                      : t('settings:seerr.never')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('settings:seerr.lastSuccess')}</p>
                  <p className="font-medium">
                    {s.lastSuccessAt
                      ? formatDistanceToNow(new Date(s.lastSuccessAt), { addSuffix: true })
                      : t('settings:seerr.never')}
                  </p>
                </div>
                {s.lastError && (
                  <div>
                    <p className="text-muted-foreground">{t('settings:seerr.lastError')}</p>
                    <p className="text-destructive font-medium break-words">{s.lastError}</p>
                  </div>
                )}
              </div>

              {isSyncing && (
                <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{syncPhase?.phase ?? t('settings:seerr.syncRunning')}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:seerr.counts')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:seerr.countsMovies', { count: s.counts.movieRequests })}
                  </p>
                  <p className="text-sm">
                    {t('settings:seerr.countsTv', { count: s.counts.tvRequests })}
                  </p>
                  {s.counts.skippedValidation > 0 && (
                    <p className="text-muted-foreground text-sm">
                      {t('settings:seerr.countsSkipped', { count: s.counts.skippedValidation })}
                    </p>
                  )}
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:seerr.attribution')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:seerr.attributionMatched')}: {s.attribution.matched}
                  </p>
                  <p className="text-sm">
                    {t('settings:seerr.attributionManual')}: {s.attribution.manual}
                  </p>
                  <p className="text-sm">
                    {t('settings:seerr.attributionUnattributed')}: {s.attribution.unattributed}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:seerr.mediaMatch')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:seerr.mediaMatchMatched')}: {s.mediaMatch.matched}
                  </p>
                  <p className="text-sm">
                    {t('settings:seerr.mediaMatchUnmatched')}: {s.mediaMatch.unmatched}
                  </p>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {s?.purgeAvailable && (
        <Card className="border-red-500/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('settings:seerr.purgeTitle')}
            </CardTitle>
            <CardDescription>{t('settings:seerr.purgeDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {purgeResult && (
              <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <p className="text-sm">
                  {t('settings:seerr.purgeResult', {
                    requests: purgeResult.requests,
                    mappings: purgeResult.mappings,
                  })}
                </p>
              </div>
            )}
            <Button
              variant="destructive"
              onClick={() => setPurgeConfirmOpen(true)}
              disabled={purge.isPending}
            >
              {purge.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('settings:seerr.purgeButton')}
            </Button>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={purgeConfirmOpen}
        onOpenChange={setPurgeConfirmOpen}
        title={t('settings:seerr.purgeConfirmTitle')}
        description={t('settings:seerr.purgeConfirmDescription')}
        confirmLabel={t('settings:seerr.purgeConfirmAction')}
        onConfirm={() => void handlePurgeConfirm()}
        isLoading={purge.isPending}
        variant="destructive"
      />

      <MappingsDialog open={mappingsOpen} onOpenChange={setMappingsOpen} />
    </div>
  );
}
