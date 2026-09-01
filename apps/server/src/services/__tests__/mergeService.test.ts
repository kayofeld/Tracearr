import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  isLoginCapable,
  assertMergeDirection,
  planServerUserMoves,
  MergeDirectionError,
  type MergeIdentitySnapshot,
} from '../mergeService.js';

function snapshot(overrides: Partial<MergeIdentitySnapshot> = {}): MergeIdentitySnapshot {
  return {
    id: randomUUID(),
    role: 'member',
    passwordHash: null,
    plexAccountId: null,
    linkedPlexAccountCount: 0,
    authAccountCount: 0,
    ...overrides,
  };
}

describe('isLoginCapable', () => {
  it('is false for a plain synced member', () => {
    expect(isLoginCapable(snapshot())).toBe(false);
  });

  it('is true for LOGIN_ROLES roles', () => {
    expect(isLoginCapable(snapshot({ role: 'owner' }))).toBe(true);
    expect(isLoginCapable(snapshot({ role: 'admin' }))).toBe(true);
  });

  it('is false for viewer, which no longer carries login rights on its own', () => {
    expect(isLoginCapable(snapshot({ role: 'viewer' }))).toBe(false);
  });

  it('is true when a password hash exists regardless of role', () => {
    expect(isLoginCapable(snapshot({ passwordHash: '$2b$12$abc' }))).toBe(true);
  });

  it('is true when a plex account id or linked plex account exists', () => {
    expect(isLoginCapable(snapshot({ plexAccountId: '12345' }))).toBe(true);
    expect(isLoginCapable(snapshot({ linkedPlexAccountCount: 1 }))).toBe(true);
  });

  it('is true when an auth account row exists', () => {
    expect(isLoginCapable(snapshot({ authAccountCount: 1 }))).toBe(true);
  });
});

describe('assertMergeDirection', () => {
  it('allows a plain synced source into any target', () => {
    expect(() => assertMergeDirection(snapshot(), snapshot({ role: 'owner' }))).not.toThrow();
    expect(() => assertMergeDirection(snapshot(), snapshot())).not.toThrow();
  });

  it('rejects a login-capable source', () => {
    expect(() => assertMergeDirection(snapshot({ role: 'admin' }), snapshot())).toThrow(
      MergeDirectionError
    );
    expect(() =>
      assertMergeDirection(snapshot({ passwordHash: '$2b$12$abc' }), snapshot())
    ).toThrow(MergeDirectionError);
    expect(() => assertMergeDirection(snapshot({ linkedPlexAccountCount: 2 }), snapshot())).toThrow(
      MergeDirectionError
    );
    expect(() => assertMergeDirection(snapshot({ authAccountCount: 1 }), snapshot())).toThrow(
      MergeDirectionError
    );
  });
});

describe('planServerUserMoves', () => {
  it('repoints everything when servers are disjoint', () => {
    const serverA = randomUUID();
    const serverB = randomUUID();
    const sourceSu = { id: randomUUID(), serverId: serverA };
    const targetSu = { id: randomUUID(), serverId: serverB };

    const plan = planServerUserMoves([sourceSu], [targetSu]);

    expect(plan.repointServerUserIds).toEqual([sourceSu.id]);
    expect(plan.combines).toEqual([]);
  });

  it('combines on server overlap and repoints the rest', () => {
    const shared = randomUUID();
    const other = randomUUID();
    const sourceShared = { id: randomUUID(), serverId: shared };
    const sourceOther = { id: randomUUID(), serverId: other };
    const targetShared = { id: randomUUID(), serverId: shared };

    const plan = planServerUserMoves([sourceShared, sourceOther], [targetShared]);

    expect(plan.repointServerUserIds).toEqual([sourceOther.id]);
    expect(plan.combines).toEqual([
      {
        sourceServerUserId: sourceShared.id,
        targetServerUserId: targetShared.id,
        serverId: shared,
      },
    ]);
  });
});
