import { describe, it, expect } from 'vitest';
import { decideEmbyOwnerLogin } from '../embyPlugin.js';

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
