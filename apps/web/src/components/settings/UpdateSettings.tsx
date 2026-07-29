import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Webhook, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import {
  useUpdateCapability,
  useSetDockerRedeployWebhook,
  useClearDockerRedeployWebhook,
} from '@/hooks/queries';

/**
 * Docker/Portainer redeploy webhook settings.
 *
 * Only meaningful on a Docker deployment - a bare-metal install already gets
 * the in-app "Update" button via the systemd self-updater, so this card
 * renders an inert/informational state there instead (see
 * `capability.isDocker`).
 *
 * The webhook URL is a secret (its embedded UUID is the Portainer auth
 * token), so - unlike the Ombi/Seerr connector fields, which round-trip
 * plaintext by design (ADR 0005) - it is genuinely write-only: the server
 * never returns it (see `Settings` in @tracearr/shared / services/settings.ts),
 * only the derived `dockerRedeployConfigured` boolean. The input therefore
 * always starts empty; it is never pre-filled from a fetched value.
 */
export function UpdateSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: capability, isLoading } = useUpdateCapability();
  const setWebhook = useSetDockerRedeployWebhook();
  const clearWebhook = useClearDockerRedeployWebhook();

  const [webhookUrl, setWebhookUrl] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  if (isLoading) {
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

  const isDocker = capability?.isDocker ?? false;
  const configured = capability?.dockerRedeployConfigured ?? false;

  const handleSave = () => {
    if (!webhookUrl.trim()) return;
    setWebhook.mutate(webhookUrl.trim(), {
      onSuccess: () => setWebhookUrl(''),
    });
  };

  const handleClearConfirm = () => {
    clearWebhook.mutate(undefined, {
      onSuccess: () => setClearConfirmOpen(false),
    });
  };

  if (!isDocker) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="h-5 w-5" />
            {t('settings:dockerUpdate.title')}
          </CardTitle>
          <CardDescription>{t('settings:dockerUpdate.bareMetalDescription')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Webhook className="h-5 w-5" />
                {t('settings:dockerUpdate.title')}
              </CardTitle>
              <CardDescription>{t('settings:dockerUpdate.description')}</CardDescription>
            </div>
            <Badge variant={configured ? 'success' : 'outline'}>
              {configured
                ? t('settings:dockerUpdate.configured')
                : t('settings:dockerUpdate.notConfigured')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="updateWebhookUrl">{t('settings:dockerUpdate.webhookUrl')}</Label>
            <PasswordInput
              id="updateWebhookUrl"
              placeholder={t('settings:dockerUpdate.webhookUrlPlaceholder')}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              {t('settings:dockerUpdate.webhookUrlHelp')}
            </p>
          </div>

          {/* Server-supplied caveat (routes/version.ts DOCKER_NOTE_*) - covers
              both "how to enable" (unconfigured) and the pinned-tag caveat
              (configured) in one place, so it's rendered verbatim rather than
              re-worded here. */}
          {capability?.dockerNote && (
            <p className="text-muted-foreground text-xs">{capability.dockerNote}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={!webhookUrl.trim() || setWebhook.isPending}>
              {setWebhook.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              {t('common:actions.save')}
            </Button>
            {configured && (
              <Button
                variant="outline"
                onClick={() => setClearConfirmOpen(true)}
                disabled={clearWebhook.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('common:actions.remove')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title={t('settings:dockerUpdate.clearConfirmTitle')}
        description={t('settings:dockerUpdate.clearConfirmDescription')}
        confirmLabel={t('settings:dockerUpdate.clearConfirmAction')}
        onConfirm={handleClearConfirm}
        isLoading={clearWebhook.isPending}
        variant="destructive"
      />
    </div>
  );
}
