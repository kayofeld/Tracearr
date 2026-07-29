import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

import {
  decideEmbyOwnerLogin,
  resolveConfiguredEmbyServerUrl,
  resolveConfiguredEmbyServerRow,
  AmbiguousEmbyServerError,
} from '../embyPlugin.js';
import { db } from '../../db/client.js';

function mockEmbyServerRows(rows: { id: string; name: string; url: string }[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

const OWNER = 'owner-1';
const EMBY = 'emby-user-9';

describe('decideEmbyOwnerLogin', () => {
  it('denies a non-admin Emby account', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: false,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: false,
    });
    expect(d).toEqual({ allow: false, reason: expect.stringMatching(/administrator/i) });
  });

  it('links (TOFU) when admin, no link yet, and the owner has no Emby binding', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: false,
    });
    expect(d).toEqual({ allow: true, needsLink: true });
  });

  it('allows a returning admin whose Emby account is already linked to the owner', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: { userId: OWNER },
      ownerHasEmbyLink: true,
    });
    expect(d).toEqual({ allow: true, needsLink: false });
  });

  it('denies an admin whose Emby account is linked to a DIFFERENT user', () => {
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: EMBY,
      linkForThisEmbyAccount: { userId: 'someone-else' },
      ownerHasEmbyLink: false,
    });
    expect(d).toMatchObject({ allow: false });
  });

  it('denies rebinding a second Emby admin once the owner is already bound (no hijack)', () => {
    // A different Emby admin tries to log in; the owner is already bound to
    // another Emby identity. Must NOT rebind/allow.
    const d = decideEmbyOwnerLogin({
      isAdmin: true,
      ownerId: OWNER,
      embyAccountId: 'a-second-admin',
      linkForThisEmbyAccount: null,
      ownerHasEmbyLink: true,
    });
    expect(d).toMatchObject({ allow: false });
  });
});

// SEC-02 fix: deterministic resolution must distinguish "no server
// configured" from "ambiguous" rather than picking an arbitrary row - see
// docs/architecture/emby-native-setup.md §4.1.
describe('resolveConfiguredEmbyServerUrl', () => {
  it('returns null when no emby server row exists', async () => {
    mockEmbyServerRows([]);
    await expect(resolveConfiguredEmbyServerUrl()).resolves.toBeNull();
  });

  it('returns the trimmed URL when exactly one row exists', async () => {
    mockEmbyServerRows([{ id: 's1', name: 'Emby', url: 'http://emby.local:8096/' }]);
    await expect(resolveConfiguredEmbyServerUrl()).resolves.toBe('http://emby.local:8096');
  });

  it('throws AmbiguousEmbyServerError when two rows exist - never silently picks one', async () => {
    mockEmbyServerRows([
      { id: 's1', name: 'Emby A', url: 'http://a.local' },
      { id: 's2', name: 'Emby B', url: 'http://b.local' },
    ]);
    await expect(resolveConfiguredEmbyServerUrl()).rejects.toBeInstanceOf(AmbiguousEmbyServerError);
  });
});

describe('resolveConfiguredEmbyServerRow', () => {
  it('returns the row id/name/url when exactly one row exists', async () => {
    mockEmbyServerRows([{ id: 's1', name: 'My Emby', url: 'http://emby.local:8096/' }]);
    await expect(resolveConfiguredEmbyServerRow()).resolves.toEqual({
      id: 's1',
      name: 'My Emby',
      url: 'http://emby.local:8096',
    });
  });
});
