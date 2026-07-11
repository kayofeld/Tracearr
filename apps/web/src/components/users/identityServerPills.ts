/**
 * Pure helper deciding when to render server membership pills for an identity.
 * Unmerged (single-server) identities render nothing - no pill noise.
 */

export interface IdentityServerMembership {
  id: string;
  name: string;
  serverUserId?: string;
  removedAt?: string | null;
}

export function getMergedIdentityServers(
  identityServers: IdentityServerMembership[] | undefined
): IdentityServerMembership[] {
  if (!identityServers || identityServers.length < 2) return [];
  return identityServers;
}

/**
 * Every server an identity belongs to, always including at least its own server.
 */
export function getIdentityServers(
  identityServers: IdentityServerMembership[] | undefined,
  ownServer: IdentityServerMembership
): IdentityServerMembership[] {
  if (!identityServers || identityServers.length === 0) return [ownServer];
  return identityServers;
}
