import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import type { Automation, Server } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { ServerBadge } from '@/components/server';

interface ScopeChipProps {
  automation: Automation;
  servers: Server[];
}

/** Where the automation applies, as one chip beside its name. */
export function ScopeChip({ automation, servers }: ScopeChipProps) {
  const { t } = useTranslation('pages');
  const scope = automation.scopeRef;

  if (!scope) {
    return <Badge variant="secondary">{t('automations.scope.global')}</Badge>;
  }

  if (scope.kind === 'server') {
    const server = servers.find((candidate) => candidate.id === scope.id);
    return (
      <ServerBadge
        server={server ?? { id: scope.id, name: scope.name, color: null }}
        variant="outlined"
      />
    );
  }

  if (scope.kind === 'person') {
    return (
      <Badge variant="secondary">
        <User aria-hidden="true" />
        {scope.name}
      </Badge>
    );
  }

  // An account sits on one server, and the row names which; the colour comes from the
  // server list when it is loaded.
  const server = scope.serverId
    ? (servers.find((candidate) => candidate.id === scope.serverId) ?? {
        id: scope.serverId,
        name: scope.serverName ?? '',
        color: null,
      })
    : undefined;

  return (
    <span className="inline-flex items-center gap-1">
      {server && <ServerBadge server={server} variant="compact" />}
      <Badge variant="secondary">
        <User aria-hidden="true" />
        {scope.name}
      </Badge>
    </span>
  );
}
