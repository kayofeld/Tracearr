/**
 * Raw SQL array literal helpers.
 *
 * Drizzle doesn't auto-convert JS arrays into a bound parameter that Postgres
 * accepts for `= ANY(...)`, so callers building `ANY()` filters against a set
 * of UUIDs need an explicit array literal instead.
 */

import { sql, type SQL } from 'drizzle-orm';

/**
 * Build a `ARRAY['id'::uuid, ...]` literal for use with `= ANY(...)`.
 * Ids come from prior DB reads (never raw user input), matching the existing
 * pattern in userService.ts and users/full.ts.
 */
export function uuidArraySql(ids: string[]): SQL {
  return sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]`);
}
