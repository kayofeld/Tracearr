import { describe, it, expect } from 'vitest';
import type { AutomationConditions } from '@tracearr/shared';
import {
  canEnforceAcrossServers,
  isScopeComplete,
  offeredScopeModes,
  scopeFromAutomation,
  scopeToPayload,
  withScopeMode,
  type AutomationScope,
} from './scope';

function conditions(...fields: string[]): AutomationConditions {
  return {
    groups: [
      {
        conditions: fields.map((field) => ({
          field,
          operator: 'gt',
          value: 1,
        })) as AutomationConditions['groups'][number]['conditions'],
      },
    ],
  };
}

describe('scopeToPayload', () => {
  it('sets exactly one column per mode', () => {
    expect(scopeToPayload({ mode: 'global' })).toEqual({
      serverId: null,
      serverUserId: null,
      userId: null,
    });
    expect(scopeToPayload({ mode: 'server', serverId: 'srv-1' })).toEqual({
      serverId: 'srv-1',
      serverUserId: null,
      userId: null,
    });
    expect(scopeToPayload({ mode: 'account', serverId: 'srv-1', serverUserId: 'su-9' })).toEqual({
      serverId: null,
      serverUserId: 'su-9',
      userId: null,
    });
    expect(scopeToPayload({ mode: 'person', userId: 'usr-3' })).toEqual({
      serverId: null,
      serverUserId: null,
      userId: 'usr-3',
    });
  });

  it('does not leak the account picker server into the payload', () => {
    const payload = scopeToPayload({ mode: 'account', serverId: 'srv-1', serverUserId: 'su-9' });
    expect(payload.serverId).toBeNull();
  });
});

describe('scopeFromAutomation', () => {
  it('reads the most specific column set', () => {
    expect(scopeFromAutomation({ userId: 'usr-3', serverId: 'srv-1' })).toEqual({
      mode: 'person',
      userId: 'usr-3',
    });
    expect(scopeFromAutomation({ serverUserId: 'su-9' }, 'srv-2')).toEqual({
      mode: 'account',
      serverId: 'srv-2',
      serverUserId: 'su-9',
    });
    expect(scopeFromAutomation({ serverId: 'srv-1' })).toEqual({
      mode: 'server',
      serverId: 'srv-1',
    });
    expect(scopeFromAutomation(undefined)).toEqual({ mode: 'global' });
  });

  it('round-trips through scopeToPayload', () => {
    const scope: AutomationScope = { mode: 'server', serverId: 'srv-1' };
    expect(scopeFromAutomation(scopeToPayload(scope))).toEqual(scope);
  });
});

describe('isScopeComplete', () => {
  it('rejects a mode whose target was never picked', () => {
    expect(isScopeComplete({ mode: 'server', serverId: '' })).toBe(false);
    expect(isScopeComplete({ mode: 'account', serverId: 'srv-1', serverUserId: '' })).toBe(false);
    expect(isScopeComplete({ mode: 'person', userId: '' })).toBe(false);
  });

  it('accepts global and fully targeted scopes', () => {
    expect(isScopeComplete({ mode: 'global' })).toBe(true);
    expect(isScopeComplete({ mode: 'account', serverId: 'srv-1', serverUserId: 'su-9' })).toBe(
      true
    );
  });

  it('accepts a stored account whose server the picker never asked for', () => {
    expect(isScopeComplete({ mode: 'account', serverId: '', serverUserId: 'su-9' })).toBe(true);
  });
});

describe('offeredScopeModes', () => {
  it('drops the two modes a lone server cannot distinguish', () => {
    expect(offeredScopeModes(1)).toEqual(['global', 'account']);
    expect(offeredScopeModes(0)).toEqual(['global', 'account']);
  });

  it('offers every mode once a second server exists', () => {
    expect(offeredScopeModes(2)).toEqual(['global', 'server', 'account', 'person']);
  });
});

describe('withScopeMode', () => {
  it('keeps a chosen server when moving between server and account', () => {
    const server: AutomationScope = { mode: 'server', serverId: 'srv-1' };
    expect(withScopeMode(server, 'account')).toEqual({
      mode: 'account',
      serverId: 'srv-1',
      serverUserId: '',
    });
  });

  it('falls back to the supplied server when the previous mode had none', () => {
    expect(withScopeMode({ mode: 'global' }, 'server', 'srv-7')).toEqual({
      mode: 'server',
      serverId: 'srv-7',
    });
  });

  it('does not carry a server into person scope', () => {
    const next = withScopeMode({ mode: 'server', serverId: 'srv-1' }, 'person', 'srv-1');
    expect(next).toEqual({ mode: 'person', userId: '' });
  });

  it('returns the same scope when the mode is unchanged', () => {
    const scope: AutomationScope = { mode: 'person', userId: 'usr-3' };
    expect(withScopeMode(scope, 'person')).toBe(scope);
  });
});

describe('canEnforceAcrossServers', () => {
  it('is never allowed for server scope', () => {
    expect(
      canEnforceAcrossServers(
        { mode: 'server', serverId: 'srv-1' },
        conditions('concurrent_streams')
      )
    ).toBe(false);
  });

  it('needs at least one identity-aware field', () => {
    expect(canEnforceAcrossServers({ mode: 'global' }, conditions('inactive_days'))).toBe(false);
    expect(
      canEnforceAcrossServers({ mode: 'global' }, conditions('inactive_days', 'concurrent_streams'))
    ).toBe(true);
  });
});
