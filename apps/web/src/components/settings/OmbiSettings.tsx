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
import { Download, CheckCircle2, XCircle, Loader2, Trash2, Users, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { WS_EVENTS } from '@tracearr/shared';
import type { OmbiRequesterMapping, OmbiSyncProgressEvent } from '@tracearr/shared';
import {
  useSettings,
  useUpdateSettings,
  useOmbiStatus,
  useOmbiMappings,
  useOmbiSync,
  useOmbiPurge,
  useUpsertOmbiMapping,
  useRevertOmbiMapping,
  useUsers,
} from '@/hooks/queries';
import { formatDistanceToNow } from 'date-fns';

const UNATTRIBUTED_VALUE = '__unattributed__';

// A narrowed callable shape for `t()` - the real TFunction's generic overloads
// make it awkward to pass around as a parameter type (mirrors the same
// narrowing used in NeverWatched.tsx).
type Translate = (key: string, options?: Record<string, unknown>) => string;

function resolutionBadge(
  mapping: OmbiRequesterMapping,
  t: Translate
): { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' } {
  switch (mapping.resolution.type) {
    case 'manual':
      return { label: t('settings:ombi.resolutionManual'), variant: 'secondary' };
    case 'provider':
    case 'username':
      return { label: t('settings:ombi.resolutionProvider'), variant: 'success' };
    case 'unattributed':
    default:
      return { label: t('settings:ombi.resolutionUnattributed'), variant: 'outline' };
  }
}

/** Requester mapping management dialog - deliberately sorts ambiguous/unattributed to the top. */
function MappingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t: rawT } = useTranslation(['settings', 'common']);
  const t = rawT as unknown as Translate;
  const mappings = useOmbiMappings(open);
  const users = useUsers({ pageSize: 100 });
  const upsertMapping = useUpsertOmbiMapping();
  const revertMapping = useRevertOmbiMapping();

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
    const rank = (m: OmbiRequesterMapping) =>
      m.ambiguous ? 0 : m.resolution.type === 'unattributed' ? 1 : 2;
    return [...list].sort((a, b) => rank(a) - rank(b) || b.requestCount - a.requestCount);
  }, [mappings.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settings:ombi.mappingsTitle')}</DialogTitle>
          <DialogDescription>{t('settings:ombi.mappingsDescription')}</DialogDescription>
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
            <p className="text-muted-foreground text-sm">{t('settings:ombi.mappingsEmpty')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings:ombi.colRequester')}</TableHead>
                <TableHead>{t('settings:ombi.colRequests')}</TableHead>
                <TableHead>{t('settings:ombi.colResolution')}</TableHead>
                <TableHead>{t('settings:ombi.colActions')}</TableHead>
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
                  <TableRow key={mapping.ombiUserId}>
                    <TableCell>
                      <div className="font-medium">{mapping.ombiAlias ?? mapping.ombiUsername}</div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {mapping.ambiguous && (
                          <Badge variant="warning">{t('settings:ombi.ambiguousBadge')}</Badge>
                        )}
                        {mapping.stale && (
                          <Badge variant="outline">{t('settings:ombi.staleBadge')}</Badge>
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
                              {t('settings:ombi.suggestions')}
                            </span>
                            {mapping.suggestions.map((s) => (
                              <Button
                                key={s.userId}
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs"
                                onClick={() =>
                                  upsertMapping.mutate({
                                    ombiUserId: mapping.ombiUserId,
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
                                ombiUserId: mapping.ombiUserId,
                                data: { userId: value === UNATTRIBUTED_VALUE ? null : value },
                              })
                            }
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue placeholder={t('settings:ombi.assignPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNATTRIBUTED_VALUE}>
                                {t('settings:ombi.forceUnattributed')}
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
                              onClick={() => revertMapping.mutate(mapping.ombiUserId)}
                            >
                              {t('settings:ombi.revertToAutomatic')}
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

export function OmbiSettings() {
  const { t } = useTranslation(['settings', 'notifications', 'common']);
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  const [ombiUrl, setOmbiUrl] = useState('');
  const [ombiApiKey, setOmbiApiKey] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [syncPhase, setSyncPhase] = useState<OmbiSyncProgressEvent | null>(null);
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeResult, setPurgeResult] = useState<{ requests: number; mappings: number } | null>(
    null
  );

  const status = useOmbiStatus();
  const syncNow = useOmbiSync();
  const purge = useOmbiPurge();

  useEffect(() => {
    if (settings) {
      setOmbiUrl(settings.ombiUrl ?? '');
      setOmbiApiKey(settings.ombiApiKey ?? '');
    }
  }, [settings]);

  // Live sync progress - mirrors the library-sync WS pattern (see useSocket.tsx).
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: OmbiSyncProgressEvent) => {
      setSyncPhase(progress);
      if (progress.phase === 'done' || progress.phase === 'error') {
        void status.refetch();
      }
    };

    socket.on(WS_EVENTS.OMBI_SYNC_PROGRESS, handleProgress);
    return () => {
      socket.off(WS_EVENTS.OMBI_SYNC_PROGRESS, handleProgress);
    };
  }, [socket, status]);

  const handleTestConnection = async () => {
    if (!ombiUrl || !ombiApiKey) {
      setConnectionStatus('error');
      setConnectionMessage(t('settings:ombi.pleaseEnterDetails'));
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage(t('settings:ombi.testingConnection'));

    try {
      const result = await api.ombi.testConnection({ url: ombiUrl, apiKey: ombiApiKey });
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(t('settings:ombi.connectedFound', { count: result.userCount ?? 0 }));
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.error || t('settings:ombi.connectionFailed'));
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(
        err instanceof Error ? err.message : t('settings:ombi.connectionFailed')
      );
    }
  };

  const handleSave = () => {
    const willBeConfigured = Boolean(ombiUrl) && Boolean(ombiApiKey);
    // The repeatable sync runs every 6h, so without this a freshly configured
    // connector would show nothing until the next scheduled run and read as broken.
    // Kick off one sync on the transition into "configured"; a 409 (already running)
    // is a no-op and is swallowed by the mutation's own error handling.
    const wasConfigured = status.data?.configured ?? false;
    updateSettings.mutate(
      {
        ombiUrl: ombiUrl || null,
        ombiApiKey: ombiApiKey || null,
      },
      {
        onSuccess: () => {
          if (willBeConfigured && !wasConfigured) {
            setSyncPhase(null);
            syncNow.mutate();
          }
        },
      }
    );
  };

  const handleSyncNow = () => {
    setSyncPhase(null);
    syncNow.mutate();
  };

  const handlePurgeConfirm = async () => {
    try {
      const result = await purge.mutateAsync();
      setPurgeResult({ requests: result.deletedRequests, mappings: result.deletedMappings });
      setPurgeConfirmOpen(false);
    } catch {
      // useOmbiPurge already toasts the failure; keep the dialog open so the
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
            <Download className="h-5 w-5" />
            {t('settings:ombi.title')}
          </CardTitle>
          <CardDescription>{t('settings:ombi.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ombiUrl">{t('settings:ombi.url')}</Label>
              <Input
                id="ombiUrl"
                placeholder={t('settings:ombi.urlPlaceholder')}
                value={ombiUrl}
                onChange={(e) => setOmbiUrl(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('settings:ombi.urlHelp')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ombiApiKey">{t('common:labels.apiKey')}</Label>
              <PasswordInput
                id="ombiApiKey"
                value={ombiApiKey}
                onChange={(e) => setOmbiApiKey(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('settings:ombi.apiKeyHelp')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => void handleTestConnection()}
                disabled={connectionStatus === 'testing' || !ombiUrl || !ombiApiKey}
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
              <CardTitle>{t('settings:ombi.statusTitle')}</CardTitle>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setMappingsOpen(true)}>
                <Users className="mr-1.5 h-3.5 w-3.5" />
                {t('settings:ombi.manageMappings')}
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
                {isSyncing ? t('settings:ombi.syncing') : t('settings:ombi.syncNow')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !s?.configured ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="font-medium">{t('settings:ombi.notConfigured')}</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('settings:ombi.notConfiguredDesc')}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground">{t('settings:ombi.lastRun')}</p>
                  <p className="font-medium">
                    {s.lastRunAt
                      ? formatDistanceToNow(new Date(s.lastRunAt), { addSuffix: true })
                      : t('settings:ombi.never')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('settings:ombi.lastSuccess')}</p>
                  <p className="font-medium">
                    {s.lastSuccessAt
                      ? formatDistanceToNow(new Date(s.lastSuccessAt), { addSuffix: true })
                      : t('settings:ombi.never')}
                  </p>
                </div>
                {s.lastError && (
                  <div>
                    <p className="text-muted-foreground">{t('settings:ombi.lastError')}</p>
                    <p className="text-destructive font-medium break-words">{s.lastError}</p>
                  </div>
                )}
              </div>

              {isSyncing && (
                <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{syncPhase?.phase ?? t('settings:ombi.syncRunning')}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:ombi.counts')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:ombi.countsMovies', { count: s.counts.movieRequests })}
                  </p>
                  <p className="text-sm">
                    {t('settings:ombi.countsTv', { count: s.counts.tvRequests })}
                  </p>
                  {s.counts.skippedValidation > 0 && (
                    <p className="text-muted-foreground text-sm">
                      {t('settings:ombi.countsSkipped', { count: s.counts.skippedValidation })}
                    </p>
                  )}
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:ombi.attribution')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:ombi.attributionMatched')}: {s.attribution.matched}
                  </p>
                  <p className="text-sm">
                    {t('settings:ombi.attributionManual')}: {s.attribution.manual}
                  </p>
                  <p className="text-sm">
                    {t('settings:ombi.attributionUnattributed')}: {s.attribution.unattributed}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs">{t('settings:ombi.mediaMatch')}</p>
                  <p className="mt-1 text-sm">
                    {t('settings:ombi.mediaMatchMatched')}: {s.mediaMatch.matched}
                  </p>
                  <p className="text-sm">
                    {t('settings:ombi.mediaMatchUnmatched')}: {s.mediaMatch.unmatched}
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
              {t('settings:ombi.purgeTitle')}
            </CardTitle>
            <CardDescription>{t('settings:ombi.purgeDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {purgeResult && (
              <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <p className="text-sm">
                  {t('settings:ombi.purgeResult', {
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
              {t('settings:ombi.purgeButton')}
            </Button>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={purgeConfirmOpen}
        onOpenChange={setPurgeConfirmOpen}
        title={t('settings:ombi.purgeConfirmTitle')}
        description={t('settings:ombi.purgeConfirmDescription')}
        confirmLabel={t('settings:ombi.purgeConfirmAction')}
        onConfirm={() => void handlePurgeConfirm()}
        isLoading={purge.isPending}
        variant="destructive"
      />

      <MappingsDialog open={mappingsOpen} onOpenChange={setMappingsOpen} />
    </div>
  );
}
