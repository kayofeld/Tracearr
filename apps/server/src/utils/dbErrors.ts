/**
 * Postgres unique_violation detection on a SPECIFIC named
 * constraint/index, shared by every owner-creating / single-row-constraint
 * insert site.
 *
 * CR-2 fix: drizzle-orm 0.45's node-postgres driver wraps every failed query
 * in `DrizzleQueryError` (drizzle-orm/errors.js), whose OWN `.message` is
 * `Failed query: <sql>\nparams: <params>` - it never contains the constraint
 * name, so the previous approach here (a substring match on `err.message`)
 * could never match; the whole SEC-05 mapping was silently dead at runtime.
 * The real pg `DatabaseError` - carrying `.code` ('23505' for
 * unique_violation, see
 * https://www.postgresql.org/docs/current/errcodes-appendix.html) and
 * `.constraint` (the exact index/constraint name Postgres reports, parsed
 * from the wire protocol's 'n' field by pg-protocol's parser.js) - lives one
 * level down at `err.cause`. This walks the `.cause` chain (rather than
 * assuming exactly one level of wrapping) and checks BOTH `code` and
 * `constraint` at each level, since a single insert site can violate more
 * than one unique index and only the named one should match here. Mirrors
 * the CLI's own `isUniqueViolation` (scripts/lib/commands.ts), generalized
 * to also require the specific constraint name.
 */
export function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current != null && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraintName) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** The partial unique index enforcing "at most one owner row" (migration 0070). */
export const USERS_SINGLE_OWNER_CONSTRAINT = 'users_single_owner';

/** The partial unique index enforcing "at most one Emby server row" (migration 0070). */
export const SERVERS_SINGLE_EMBY_CONSTRAINT = 'servers_single_emby';

/** The partial unique index enforcing "at most one Emby account link per user" (db/timescale.ts). */
export const AUTH_ACCOUNTS_ONE_EMBY_PER_USER_CONSTRAINT = 'auth_accounts_one_emby_per_user';
