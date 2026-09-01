import { useTranslation } from 'react-i18next';
import { useSocket } from '@/hooks/useSocket';
import { LayoutBanner } from './LayoutBanner';

/**
 * Banner that displays when one or more servers are unreachable.
 * Updates in real-time via WebSocket events.
 */
export function ServerHealthBanner() {
  const { t } = useTranslation('settings');
  const { unhealthyServers } = useSocket();

  if (unhealthyServers.length === 0) {
    return null;
  }

  const serverNames = unhealthyServers.map((s) => s.serverName).join(', ');
  const message =
    unhealthyServers.length === 1
      ? t('serverHealth.unreachable', { serverName: serverNames })
      : t('serverHealth.multipleUnreachable', {
          count: unhealthyServers.length,
          serverNames,
        });

  return <LayoutBanner variant="destructive">{message}</LayoutBanner>;
}
