import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Link2, Unlink, Loader2, XCircle, Server, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PlexAccount } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Plex OAuth configuration. The client identifier is NOT hardcoded: plex.tv
// scopes a PIN to the identifier that created it, and the server redeems the
// PIN this component creates, so both ends must send the same per-install
// value. It comes from GET /auth/plex/accounts.
const PLEX_OAUTH_URL = 'https://app.plex.tv/auth#';
const PIN_POLL_INTERVAL_MS = 2000;
const PIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolves with the authorized pin id, which the server redeems for a token. */
async function runPlexOAuth(clientIdentifier: string): Promise<string> {
  const pinResponse = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Plex-Client-Identifier': clientIdentifier,
      'X-Plex-Product': 'Tracearr',
    },
    body: JSON.stringify({
      strong: true,
      'X-Plex-Product': 'Tracearr',
      'X-Plex-Client-Identifier': clientIdentifier,
    }),
  });

  if (!pinResponse.ok) {
    throw new Error('Failed to create Plex PIN');
  }

  const pin = (await pinResponse.json()) as { id: number; code: string };
  const oauthUrl = `${PLEX_OAUTH_URL}?clientID=${clientIdentifier}&code=${pin.code}&context%5Bdevice%5D%5Bproduct%5D=Tracearr`;
  const oauthWindow = window.open(oauthUrl, 'plex_oauth', 'width=600,height=700');

  try {
    const deadline = Date.now() + PIN_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PIN_POLL_INTERVAL_MS));

      const check = await fetch(`https://plex.tv/api/v2/pins/${pin.id}`, {
        headers: {
          Accept: 'application/json',
          'X-Plex-Client-Identifier': clientIdentifier,
        },
      }).catch(() => null);

      if (!check) continue;
      if (!check.ok) throw new Error('Failed to check PIN status');

      const { authToken } = (await check.json()) as { authToken: string | null };
      if (authToken) return String(pin.id);
    }

    throw new Error('OAuth timeout - please try again');
  } finally {
    oauthWindow?.close();
  }
}

interface PlexAccountsManagerProps {
  compact?: boolean; // For inline display in server settings
  onAccountLinked?: (accountId: string) => void;
}

export function PlexAccountsManager({
  compact = false,
  onAccountLinked,
}: PlexAccountsManagerProps) {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const queryClient = useQueryClient();
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [reauthorizingId, setReauthorizingId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Both flows drive the same named popup, so a second start would steal the
  // first one's window and leave it polling a PIN nobody will authorize.
  const oauthBusy = isLinking || reauthorizingId !== null;

  // Fetch plex accounts
  const {
    data: accountsData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['plex-accounts'],
    queryFn: () => api.auth.getPlexAccounts(),
  });

  const accounts = accountsData?.accounts ?? [];
  const plexClientId = accountsData?.clientIdentifier;

  // Unlink mutation
  const unlinkMutation = useMutation({
    mutationFn: (id: string) => api.auth.unlinkPlexAccount(id),
    onSuccess: () => {
      toast.success(t('toast.success.plexAccountUnlinked.title'), {
        description: t('toast.success.plexAccountUnlinked.message'),
      });
      void refetch();
      setShowUnlinkConfirm(null);
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.plexUnlinkFailed'), {
        description: error.message,
      });
    },
  });

  // Start Plex OAuth flow for linking
  const startPlexOAuth = async () => {
    if (!plexClientId) {
      setLinkError('Plex client identifier unavailable - reload and try again');
      return;
    }

    setIsLinking(true);
    setLinkError(null);

    try {
      const pinId = await runPlexOAuth(plexClientId);
      const { account } = await api.auth.linkPlexAccount(pinId);

      toast.success(t('toast.success.plexAccountLinked.title'), {
        description: t('toast.success.plexAccountLinked.message'),
      });
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
      onAccountLinked?.(account.id);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'Failed to link account');
    } finally {
      setIsLinking(false);
    }
  };

  const startReauthorize = async (accountId: string) => {
    if (!plexClientId) {
      setLinkError('Plex client identifier unavailable - reload and try again');
      return;
    }

    setReauthorizingId(accountId);
    setLinkError(null);

    try {
      const pinId = await runPlexOAuth(plexClientId);
      const result = await api.auth.reauthorizePlexAccount(accountId, pinId);

      const reconnected = result.servers.filter((s) => s.ok);
      const unmatched = result.servers.filter((s) => s.status === 'unmatched');
      const failed = result.servers.filter((s) => !s.ok && s.status !== 'unmatched');

      if (failed.length > 0 || unmatched.length > 0) {
        toast.warning(t('toast.success.plexAccountReauthorized.title'), {
          description:
            failed.length > 0
              ? t('toast.success.plexAccountReauthorized.partial', {
                  names: failed.map((s) => s.name).join(', '),
                })
              : t('toast.success.plexAccountReauthorized.unmatched', {
                  names: unmatched.map((s) => s.name).join(', '),
                }),
        });
      } else {
        toast.success(t('toast.success.plexAccountReauthorized.title'), {
          description:
            reconnected.length === 0
              ? t('toast.success.plexAccountReauthorized.messageNoServers')
              : t('toast.success.plexAccountReauthorized.message', {
                  count: reconnected.length,
                }),
        });
      }

      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reauthorize account';
      setLinkError(message);
      toast.error(t('toast.error.plexReauthorizeFailed'), { description: message });
    } finally {
      setReauthorizingId(null);
    }
  };

  // Compact view - just shows count and manage button
  if (compact) {
    if (isLoading) {
      return <Skeleton className="h-6 w-48" />;
    }

    return (
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-sm">
          {accounts.length === 0
            ? t('pages:settings.plex.noAccountsLinkedShort')
            : t('pages:settings.plex.accountsLinked', { count: accounts.length })}
        </span>
        <Button variant="outline" size="sm" onClick={() => setShowManageDialog(true)}>
          {t('common:actions.edit')}
        </Button>
        <ManageDialog
          open={showManageDialog}
          onOpenChange={setShowManageDialog}
          accounts={accounts}
          isLoading={isLoading}
          isLinking={isLinking}
          oauthBusy={oauthBusy}
          linkError={linkError}
          onLink={startPlexOAuth}
          onUnlink={(id) => setShowUnlinkConfirm(id)}
          onReauthorize={(id) => void startReauthorize(id)}
          reauthorizingId={reauthorizingId}
        />
        <ConfirmDialog
          open={!!showUnlinkConfirm}
          onOpenChange={() => setShowUnlinkConfirm(null)}
          title={t('pages:settings.plex.unlinkPlexAccount')}
          description={t('pages:settings.plex.unlinkConfirm')}
          confirmLabel={t('common:actions.disconnect')}
          onConfirm={() => showUnlinkConfirm && unlinkMutation.mutate(showUnlinkConfirm)}
          isLoading={unlinkMutation.isPending}
        />
      </div>
    );
  }

  // Full view - shows all accounts inline
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
          <Link2 className="text-muted-foreground h-8 w-8" />
          <div>
            <p className="font-medium">{t('pages:settings.plex.noAccountsLinked')}</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {t('pages:settings.plex.noAccountsLinkedHint')}
            </p>
          </div>
          <Button onClick={startPlexOAuth} disabled={oauthBusy}>
            {isLinking ? (
              <>
                <Loader2 className="animate-spin" />
                {t('pages:settings.plex.linking')}
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {t('pages:settings.plex.linkPlexAccount')}
              </>
            )}
          </Button>
          {linkError && (
            <p className="text-destructive flex items-center gap-1 text-sm">
              <XCircle className="h-4 w-4" />
              {linkError}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {accounts.map((account) => (
              <PlexAccountCard
                key={account.id}
                account={account}
                onUnlink={() => setShowUnlinkConfirm(account.id)}
                onReauthorize={() => void startReauthorize(account.id)}
                isReauthorizing={reauthorizingId === account.id}
                oauthBusy={oauthBusy}
              />
            ))}
          </div>
          <Button variant="outline" onClick={startPlexOAuth} disabled={oauthBusy}>
            {isLinking ? (
              <>
                <Loader2 className="animate-spin" />
                {t('pages:settings.plex.linking')}
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {t('pages:settings.plex.linkAnotherAccount')}
              </>
            )}
          </Button>
          {linkError && (
            <p className="text-destructive flex items-center gap-1 text-sm">
              <XCircle className="h-4 w-4" />
              {linkError}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!showUnlinkConfirm}
        onOpenChange={() => setShowUnlinkConfirm(null)}
        title={t('pages:settings.plex.unlinkPlexAccount')}
        description={t('pages:settings.plex.unlinkConfirm')}
        confirmLabel={t('common:actions.disconnect')}
        onConfirm={() => showUnlinkConfirm && unlinkMutation.mutate(showUnlinkConfirm)}
        isLoading={unlinkMutation.isPending}
      />
    </div>
  );
}

function PlexAccountCard({
  account,
  onUnlink,
  onReauthorize,
  isReauthorizing,
  oauthBusy,
}: {
  account: PlexAccount;
  onUnlink: () => void;
  onReauthorize: () => void;
  isReauthorizing: boolean;
  oauthBusy: boolean;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const canUnlink = account.serverCount === 0;

  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={account.plexThumbnail ?? undefined} />
          <AvatarFallback>{account.plexUsername?.[0]?.toUpperCase() ?? 'P'}</AvatarFallback>
        </Avatar>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
            </span>
            {account.allowLogin && (
              <Badge variant="secondary" className="text-xs">
                {t('pages:settings.plex.loginEnabled')}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Server className="h-3 w-3" />
            <span>{t('pages:settings.plex.serversConnected', { count: account.serverCount })}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReauthorize}
          disabled={oauthBusy}
          title={t('pages:settings.plex.reauthorizeAccount')}
          aria-label={t('pages:settings.plex.reauthorizeAccount')}
        >
          {isReauthorizing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUnlink}
          disabled={!canUnlink}
          title={
            canUnlink
              ? t('pages:settings.plex.unlinkAccount')
              : t('pages:settings.plex.deleteServersFirst')
          }
          aria-label={t('pages:settings.plex.unlinkAccount')}
        >
          <Unlink className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ManageDialog({
  open,
  onOpenChange,
  accounts,
  isLoading,
  isLinking,
  oauthBusy,
  linkError,
  onLink,
  onUnlink,
  onReauthorize,
  reauthorizingId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: PlexAccount[];
  isLoading: boolean;
  isLinking: boolean;
  oauthBusy: boolean;
  linkError: string | null;
  onLink: () => void;
  onUnlink: (id: string) => void;
  onReauthorize: (id: string) => void;
  reauthorizingId: string | null;
}) {
  const { t } = useTranslation(['pages', 'common']);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pages:settings.plex.linkedAccounts')}</DialogTitle>
          <DialogDescription>{t('pages:settings.plex.linkedAccountsDesc')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[400px] space-y-3 overflow-y-auto py-4">
          {isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
              <Link2 className="text-muted-foreground h-8 w-8" />
              <p className="text-muted-foreground text-sm">
                {t('pages:settings.plex.noAccountsYet')}
              </p>
            </div>
          ) : (
            accounts.map((account) => (
              <PlexAccountCard
                key={account.id}
                account={account}
                onUnlink={() => onUnlink(account.id)}
                onReauthorize={() => onReauthorize(account.id)}
                isReauthorizing={reauthorizingId === account.id}
                oauthBusy={oauthBusy}
              />
            ))
          )}
        </div>
        {linkError && (
          <p className="text-destructive flex items-center gap-1 text-sm">
            <XCircle className="h-4 w-4" />
            {linkError}
          </p>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
          <Button onClick={onLink} disabled={oauthBusy}>
            {isLinking ? (
              <>
                <Loader2 className="animate-spin" />
                {t('pages:settings.plex.linking')}
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {t('pages:settings.plex.linkPlexAccount')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
