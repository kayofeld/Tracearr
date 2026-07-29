/**
 * Postgres unique_violation detection shared by every owner-creating /
 * single-row-constraint site. Mirrors the technique embyPlugin.ts already
 * used for `auth_accounts_one_emby_per_user` (a raw substring match on the
 * driver's error message) - extracted here so `users_single_owner` and
 * `servers_single_emby` violations are mapped identically at EVERY insert
 * site that can hit them (embySetupPlugin.ts, both plexPlugin.ts owner
 * inserts, POST /servers), not just the one a review happened to cite.
 */
export function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  return err instanceof Error && err.message.includes(constraintName);
}

/** The partial unique index enforcing "at most one owner row" (migration 0070). */
export const USERS_SINGLE_OWNER_CONSTRAINT = 'users_single_owner';

/** The partial unique index enforcing "at most one Emby server row" (migration 0070). */
export const SERVERS_SINGLE_EMBY_CONSTRAINT = 'servers_single_emby';
