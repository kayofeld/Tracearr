import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
// Exit node disabled — this will come back when we implement SOCKS proxy support
// import {
//   Select,
//   SelectContent,
//   SelectItem,
//   SelectTrigger,
//   SelectValue,
// } from '@/components/ui/select';
import {
  Loader2,
  ExternalLink,
  CheckCircle2,
  Info,
  XCircle,
  RefreshCw,
  ChevronDown,
} from 'lucide-react';
import { BASE_URL } from '@/lib/basePath';
import {
  useTailscaleStatus,
  useTailscaleLogs,
  useEnableTailscale,
  useDisableTailscale,
  // useSetExitNode, // Exit node disabled — will come back with SOCKS proxy support
  useResetTailscale,
} from '@/hooks/queries';

function TailscaleLogo({ className }: { className?: string }) {
  return (
    <>
      <img
        src={`${BASE_URL}images/tailscale-dark.svg`}
        alt=""
        className={`dark:hidden ${className}`}
      />
      <img
        src={`${BASE_URL}images/tailscale-light.svg`}
        alt=""
        className={`hidden dark:block ${className}`}
      />
    </>
  );
}

export function TailscaleSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: status, isLoading } = useTailscaleStatus();
  const queryClient = useQueryClient();
  const enableMutation = useEnableTailscale();
  const disableMutation = useDisableTailscale();
  const resetMutation = useResetTailscale();
  // const exitNodeMutation = useSetExitNode();
  const [hostname, setHostname] = useState('');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isActive = status?.status !== undefined && status.status !== 'disabled';
  const { data: logs } = useTailscaleLogs(showLogs && isActive);

  const handleRefresh = useCallback(() => {
    setRefreshed(true);
    void queryClient.invalidateQueries({ queryKey: ['tailscale', 'status'] });
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRefreshed(false), 600);
  }, [queryClient]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Binary not available (not running in official Docker image)
  if (!status?.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TailscaleLogo className="h-5 w-5" />
            {t('tailscale.title')}
            <span className="rounded bg-amber-500/10 px-2 py-1 text-sm leading-normal font-semibold tracking-wide text-amber-500">
              BETA
            </span>
          </CardTitle>
          <CardDescription>{t('tailscale.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info />
            <AlertDescription>{t('tailscale.notAvailable')}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TailscaleLogo className="h-5 w-5" />
            {t('tailscale.title')}
            <span className="rounded bg-amber-500/10 px-2 py-1 text-sm leading-normal font-semibold tracking-wide text-amber-500">
              BETA
            </span>
            {status.status !== 'disabled' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleRefresh}
                disabled={refreshed}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 transition-opacity duration-300 ${refreshed ? 'opacity-30' : ''}`}
                />
              </Button>
            )}
          </CardTitle>
          <CardDescription>{t('tailscale.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Disabled state */}
          {status.status === 'disabled' && (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">{t('tailscale.disabledDescription')}</p>
              <div className="space-y-2">
                <Label htmlFor="ts-hostname">{t('tailscale.hostnameLabel')}</Label>
                <Input
                  id="ts-hostname"
                  placeholder="tracearr"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))}
                  pattern="^[a-zA-Z0-9-]*$"
                  className="max-w-xs"
                />
                <p className="text-muted-foreground text-xs">{t('tailscale.hostnameHint')}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => enableMutation.mutate(hostname || undefined)}
                  disabled={enableMutation.isPending}
                >
                  {enableMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('tailscale.enable')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={resetMutation.isPending}
                >
                  {t('common:actions.reset')}
                </Button>
              </div>
            </div>
          )}

          {/* Starting state */}
          {status.status === 'starting' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-muted-foreground">{t('tailscale.starting')}</span>
              </div>
              <Button
                variant="destructive"
                onClick={() => disableMutation.mutate()}
                disabled={disableMutation.isPending}
              >
                {t('common:actions.cancel')}
              </Button>
            </div>
          )}

          {/* Awaiting auth state */}
          {status.status === 'awaiting_auth' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-muted-foreground">{t('tailscale.awaitingAuth')}</span>
              </div>
              <div className="flex gap-2">
                {status.authUrl && (
                  <Button variant="default" onClick={() => window.open(status.authUrl!, '_blank')}>
                    <ExternalLink />
                    {t('tailscale.authorize')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => disableMutation.mutate()}
                  disabled={disableMutation.isPending}
                >
                  {t('common:actions.cancel')}
                </Button>
              </div>
            </div>
          )}

          {/* Connected state */}
          {status.status === 'connected' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                <span>{t('tailscale.connected')}</span>
              </div>
              <table className="text-sm">
                <tbody>
                  {status.tailnetName && (
                    <tr>
                      <td className="text-muted-foreground py-1.5 pr-4 align-top">Tailnet</td>
                      <td className="py-1.5 font-mono text-xs">{status.tailnetName}</td>
                    </tr>
                  )}
                  {status.hostname && (
                    <tr>
                      <td className="text-muted-foreground py-1.5 pr-4 align-top">
                        {t('tailscale.hostname')}
                      </td>
                      <td className="py-1.5 font-mono text-xs">{status.hostname}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="text-muted-foreground py-1.5 pr-4 align-top">Tailnet IP</td>
                    <td className="py-1.5 font-mono text-xs">{status.tailnetIp}</td>
                  </tr>
                  {status.dnsName && (
                    <tr>
                      <td className="text-muted-foreground py-1.5 pr-4 align-top">
                        {t('tailscale.dnsName')}
                      </td>
                      <td className="py-1.5 font-mono text-xs">{status.dnsName}</td>
                    </tr>
                  )}
                  {status.tailnetUrl && (
                    <tr>
                      <td className="text-muted-foreground py-1.5 pr-4 align-top">
                        {t('tailscale.tailnetUrl')}
                      </td>
                      <td className="py-1.5 font-mono text-xs">
                        <a
                          href={status.tailnetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {status.tailnetUrl}
                        </a>
                      </td>
                    </tr>
                  )}
                  {/* Exit node disabled — this will come back when we implement SOCKS proxy support */}
                  {/* {status.exitNodes.length > 0 && (
                    <tr>
                      <td className="text-muted-foreground py-1.5 pr-4 align-top">Exit Node</td>
                      <td className="py-1.5">
                        <Select
                          value={status.exitNodes.find((n) => n.active)?.id ?? 'none'}
                          onValueChange={(value) =>
                            exitNodeMutation.mutate(value === 'none' ? null : value)
                          }
                          disabled={exitNodeMutation.isPending}
                        >
                          <SelectTrigger className="h-7 w-auto min-w-32 font-mono text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t('tailscale.exitNodeNone')}</SelectItem>
                            {status.exitNodes.map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.hostname}
                                {!node.online && (
                                  <span className="text-muted-foreground ml-1">
                                    {t('tailscale.exitNodeOffline')}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  )} */}
                </tbody>
              </table>

              <Button variant="destructive" onClick={() => setShowDisableConfirm(true)}>
                {t('tailscale.disable')}
              </Button>
            </div>
          )}

          {/* Stopping state */}
          {status.status === 'stopping' && (
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-muted-foreground">{t('tailscale.stopping')}</span>
            </div>
          )}

          {/* Error state */}
          {status.status === 'error' && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <XCircle />
                <AlertDescription>{status.error || t('tailscale.unknownError')}</AlertDescription>
              </Alert>
              <div className="flex gap-2">
                <Button
                  onClick={() => enableMutation.mutate(hostname || undefined)}
                  disabled={enableMutation.isPending}
                >
                  {enableMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('common:actions.retry')}
                </Button>
                <Button variant="destructive" onClick={() => setShowDisableConfirm(true)}>
                  {t('tailscale.disable')}
                </Button>
              </div>
            </div>
          )}

          {/* Collapsible logs section */}
          {isActive && (
            <div className="border-t pt-3">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                onClick={() => setShowLogs((v) => !v)}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showLogs ? '' : '-rotate-90'}`}
                />
                {showLogs ? t('tailscale.hideLogs') : t('tailscale.showLogs')}
              </button>
              {showLogs && (
                <pre className="bg-muted mt-2 h-96 max-h-[48rem] min-h-24 resize-y overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                  {logs || t('tailscale.noLogs')}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDisableConfirm}
        onOpenChange={setShowDisableConfirm}
        title={t('tailscale.disableConfirmTitle')}
        description={t('tailscale.disableConfirmDescription')}
        confirmLabel={t('tailscale.disable')}
        onConfirm={() => {
          disableMutation.mutate();
          setShowDisableConfirm(false);
        }}
        isLoading={disableMutation.isPending}
        variant="destructive"
      />

      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={t('tailscale.resetConfirmTitle')}
        description={t('tailscale.resetConfirmDescription')}
        confirmLabel={t('common:actions.reset')}
        onConfirm={() => {
          resetMutation.mutate();
          setShowResetConfirm(false);
        }}
        isLoading={resetMutation.isPending}
        variant="destructive"
      />
    </>
  );
}
