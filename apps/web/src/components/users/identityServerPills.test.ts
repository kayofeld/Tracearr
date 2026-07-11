import { describe, it, expect } from 'vitest';
import { getMergedIdentityServers, getIdentityServers } from './identityServerPills';

describe('getMergedIdentityServers', () => {
  it('returns an empty array for an unmerged (single-server) identity', () => {
    expect(getMergedIdentityServers([{ id: 'srv-a', name: 'Plex' }])).toEqual([]);
  });

  it('returns an empty array when identityServers is undefined', () => {
    expect(getMergedIdentityServers(undefined)).toEqual([]);
  });

  it('returns an empty array when identityServers is empty', () => {
    expect(getMergedIdentityServers([])).toEqual([]);
  });

  it('returns all memberships for a merged (multi-server) identity', () => {
    const servers = [
      { id: 'srv-a', name: 'Plex' },
      { id: 'srv-b', name: 'Jellyfin' },
    ];
    expect(getMergedIdentityServers(servers)).toEqual(servers);
  });
});

describe('getIdentityServers', () => {
  const ownServer = { id: 'srv-a', name: 'Plex' };

  it('falls back to the own server when identityServers is undefined', () => {
    expect(getIdentityServers(undefined, ownServer)).toEqual([ownServer]);
  });

  it('falls back to the own server when identityServers is empty', () => {
    expect(getIdentityServers([], ownServer)).toEqual([ownServer]);
  });

  it('returns all memberships for a merged identity', () => {
    const servers = [ownServer, { id: 'srv-b', name: 'Jellyfin' }];
    expect(getIdentityServers(servers, ownServer)).toEqual(servers);
  });
});
