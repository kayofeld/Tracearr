import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Automation, AutomationScopeRef, Server } from '@tracearr/shared';
import { ScopeChip } from './ScopeChip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const servers: Server[] = [
  {
    id: 'srv-plex',
    name: 'Plex',
    type: 'plex',
    url: '',
    color: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'srv-jf',
    name: 'Jellyfin',
    type: 'jellyfin',
    url: '',
    color: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

function automation(scopeRef: AutomationScopeRef | null): Automation {
  return {
    id: 'a-1',
    name: 'Nudge',
    description: null,
    kind: 'notification',
    severity: null,
    triggers: [],
    conditions: { groups: [] },
    actions: { actions: [] },
    serverId: scopeRef?.kind === 'server' ? scopeRef.id : null,
    serverUserId: scopeRef?.kind === 'account' ? scopeRef.id : null,
    userId: scopeRef?.kind === 'person' ? scopeRef.id : null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('ScopeChip', () => {
  it('names the account and the server the row says it sits on', () => {
    render(
      <ScopeChip
        automation={automation({
          kind: 'account',
          id: 'su-plex',
          name: 'alice-plex',
          serverId: 'srv-plex',
          serverName: 'Plex',
        })}
        servers={servers}
      />
    );

    expect(screen.getByText('alice-plex')).toBeInTheDocument();
    expect(screen.getByLabelText('Plex')).toBeInTheDocument();
  });

  it('names an account whose server has not loaded yet from the row itself', () => {
    render(
      <ScopeChip
        automation={automation({
          kind: 'account',
          id: 'su-jf',
          name: 'alice-jf',
          serverId: 'srv-jf',
          serverName: 'Jellyfin',
        })}
        servers={[]}
      />
    );

    expect(screen.getByText('alice-jf')).toBeInTheDocument();
    expect(screen.getByLabelText('Jellyfin')).toBeInTheDocument();
  });

  it('names the person a person-scoped row applies to', () => {
    render(
      <ScopeChip
        automation={automation({ kind: 'person', id: 'usr-1', name: 'Alice' })}
        servers={servers}
      />
    );

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('names the server a server-scoped row applies to', () => {
    render(
      <ScopeChip
        automation={automation({ kind: 'server', id: 'srv-plex', name: 'Plex' })}
        servers={servers}
      />
    );

    expect(screen.getByTitle('Plex')).toBeInTheDocument();
  });

  it('says global when the row applies everywhere', () => {
    render(<ScopeChip automation={automation(null)} servers={servers} />);

    expect(screen.getByText('automations.scope.global')).toBeInTheDocument();
  });
});
