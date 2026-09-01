import { describe, it, expect } from 'vitest';
import { deriveMergeActionState, findOverlappingServerName } from './mergeSelection';

describe('deriveMergeActionState', () => {
  it('disables merge and flags the same-identity reason when both selected rows share a userId', () => {
    const result = deriveMergeActionState([{ userId: 'user-1' }, { userId: 'user-1' }], false);

    expect(result).toEqual({ disabled: true, reasonKey: 'pages:users.mergeSameIdentity' });
  });

  it('enables merge when exactly two rows with different userIds are selected', () => {
    const result = deriveMergeActionState([{ userId: 'user-1' }, { userId: 'user-2' }], false);

    expect(result).toEqual({ disabled: false });
  });

  it('disables merge with the select-two reason when fewer than two rows are selected', () => {
    const result = deriveMergeActionState([{ userId: 'user-1' }], false);

    expect(result).toEqual({ disabled: true, reasonKey: 'pages:users.mergeSelectTwo' });
  });

  it('disables merge with the select-two reason when more than two rows are selected', () => {
    const result = deriveMergeActionState(
      [{ userId: 'user-1' }, { userId: 'user-2' }, { userId: 'user-3' }],
      false
    );

    expect(result).toEqual({ disabled: true, reasonKey: 'pages:users.mergeSelectTwo' });
  });

  it('disables merge with a distinct reason when select-all mode is active', () => {
    const result = deriveMergeActionState([], true);

    expect(result).toEqual({ disabled: true, reasonKey: 'pages:users.mergeSelectAllActive' });
  });
});

describe('findOverlappingServerName', () => {
  it('returns the name of the server both candidates share an account on', () => {
    const first = [
      { serverId: 'server-1', serverName: 'Living Room Plex' },
      { serverId: 'server-2', serverName: 'Bedroom Jellyfin' },
    ];
    const second = [{ serverId: 'server-2', serverName: 'Bedroom Jellyfin' }];

    expect(findOverlappingServerName(first, second)).toBe('Bedroom Jellyfin');
  });

  it('returns null when the candidates have no server in common', () => {
    const first = [{ serverId: 'server-1', serverName: 'Living Room Plex' }];
    const second = [{ serverId: 'server-2', serverName: 'Bedroom Jellyfin' }];

    expect(findOverlappingServerName(first, second)).toBeNull();
  });

  it('returns null when either candidate has no server accounts', () => {
    expect(findOverlappingServerName([], [])).toBeNull();
    expect(
      findOverlappingServerName([], [{ serverId: 'server-1', serverName: 'Living Room Plex' }])
    ).toBeNull();
  });
});
