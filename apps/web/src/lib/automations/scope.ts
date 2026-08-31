/**
 * The API carries scope in three mutually exclusive nullable columns. Holding
 * them as three pieces of UI state let a half-filled picker serialize to
 * all-null, silently saving a targeted automation as a global one.
 */

import type { AutomationConditions } from '@tracearr/shared';
import { IDENTITY_AWARE_CONDITION_FIELDS } from '@tracearr/shared';

export type AutomationScopeMode = 'global' | 'server' | 'account' | 'person';

export type AutomationScope =
  | { mode: 'global' }
  | { mode: 'server'; serverId: string }
  | { mode: 'account'; serverId: string; serverUserId: string }
  | { mode: 'person'; userId: string };

const SCOPE_MODES: readonly AutomationScopeMode[] = ['global', 'server', 'account', 'person'];

const SINGLE_SERVER_SCOPE_MODES: readonly AutomationScopeMode[] = ['global', 'account'];

// On one server, `server` is a second spelling of global and an identity cannot
// span more accounts than the one, so only two of the four modes mean anything.
export function offeredScopeModes(serverCount: number): readonly AutomationScopeMode[] {
  return serverCount >= 2 ? SCOPE_MODES : SINGLE_SERVER_SCOPE_MODES;
}

export interface AutomationScopePayload {
  serverId: string | null;
  serverUserId: string | null;
  userId: string | null;
}

interface ScopedAutomationFields {
  serverId?: string | null;
  serverUserId?: string | null;
  userId?: string | null;
}

export function scopeToPayload(scope: AutomationScope): AutomationScopePayload {
  switch (scope.mode) {
    case 'server':
      return { serverId: scope.serverId, serverUserId: null, userId: null };
    case 'account':
      return { serverId: null, serverUserId: scope.serverUserId, userId: null };
    case 'person':
      return { serverId: null, serverUserId: null, userId: scope.userId };
    case 'global':
      return { serverId: null, serverUserId: null, userId: null };
  }
}

// Account scope carries a serverId only so the picker knows whose roster to list;
// the automation stores the account alone, so the caller passes scopeRef's server.
export function scopeFromAutomation(
  automation: ScopedAutomationFields | undefined,
  accountServerId = ''
): AutomationScope {
  if (automation?.userId) return { mode: 'person', userId: automation.userId };
  if (automation?.serverUserId) {
    return { mode: 'account', serverId: accountServerId, serverUserId: automation.serverUserId };
  }
  if (automation?.serverId) return { mode: 'server', serverId: automation.serverId };
  return { mode: 'global' };
}

// Keeps a chosen server when moving between modes that both use one.
export function withScopeMode(
  scope: AutomationScope,
  mode: AutomationScopeMode,
  fallbackServerId = ''
): AutomationScope {
  if (scope.mode === mode) return scope;
  const serverId = 'serverId' in scope && scope.serverId ? scope.serverId : fallbackServerId;

  switch (mode) {
    case 'global':
      return { mode: 'global' };
    case 'server':
      return { mode: 'server', serverId };
    case 'account':
      return { mode: 'account', serverId, serverUserId: '' };
    case 'person':
      return { mode: 'person', userId: '' };
  }
}

export function isScopeComplete(scope: AutomationScope): boolean {
  switch (scope.mode) {
    case 'global':
      return true;
    case 'server':
      return scope.serverId !== '';
    // The server behind an account is only there to list the roster; the payload never carries it.
    case 'account':
      return scope.serverUserId !== '';
    case 'person':
      return scope.userId !== '';
  }
}

// Server-scoped automations evaluate one server's sessions, and the backend rejects
// the combination, so cross-server enforcement is off the table there.
export function canEnforceAcrossServers(
  scope: AutomationScope,
  conditions: AutomationConditions
): boolean {
  if (scope.mode === 'server') return false;
  const identityAware = IDENTITY_AWARE_CONDITION_FIELDS as readonly string[];
  return conditions.groups.some((group) =>
    group.conditions.some((condition) => identityAware.includes(condition.field))
  );
}
