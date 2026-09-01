/**
 * Server-side helpers for the shared list contract in `@tracearr/shared`.
 *
 * The wire shape (query params, response envelope) lives in the shared package
 * because the client parses it too. This file holds the pieces that only make
 * sense next to a database: turning a validated sort field into an ORDER BY the
 * planner can serve from an index.
 */

import { sql, type SQL } from 'drizzle-orm';

export type SortDirection = 'asc' | 'desc';

export interface SortKey {
  /** The ordering expression. Built from route-local fragments, never from caller input. */
  key: SQL;
  /** Direction applied when the client does not pin one. */
  defaultDir: SortDirection;
  /**
   * Null placement, emitted in both directions when set. Postgres defaults
   * differ per direction (ASC NULLS LAST, DESC NULLS FIRST) and the planner
   * compares the placement even on a NOT NULL column, so leaving it implicit is
   * what silently turns a matching index scan into an incremental sort.
   */
  nulls?: 'first' | 'last';
}

/**
 * Compose `ORDER BY <whitelisted key> <dir> [NULLS ...], <tiebreak> ASC`.
 *
 * `orderBy` has already been narrowed to a key of `whitelist` by the route's
 * Zod enum, so nothing here interpolates caller input. The tiebreak is always
 * ascending: it only has to make paging deterministic, and pinning it to one
 * direction keeps it matchable against a plain index column.
 */
export function buildOrderBy<TField extends string>(
  whitelist: Record<TField, SortKey>,
  orderBy: TField,
  orderDir: SortDirection | undefined,
  tiebreak: SQL
): SQL {
  const entry = whitelist[orderBy];
  const dir = (orderDir ?? entry.defaultDir) === 'asc' ? sql`ASC` : sql`DESC`;
  const nulls =
    entry.nulls === 'last' ? sql` NULLS LAST` : entry.nulls === 'first' ? sql` NULLS FIRST` : sql``;

  return sql`${entry.key} ${dir}${nulls}, ${tiebreak} ASC`;
}

/** ILIKE treats these as wildcards, so a literal search for them has to escape. */
export function likePattern(search: string): string {
  return `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * Resolve a calendar date to the start of that UTC day.
 *
 * List filters take calendar days, not instants, so both bounds are half-open:
 * `>= dayStart(from)` and `< dayEnd(to)`. An inclusive `<= to` compares against
 * midnight and silently drops everything that happened on the day the user
 * named.
 */
export function utcDayStart(date: string | undefined): Date | undefined {
  return date ? new Date(`${date}T00:00:00.000Z`) : undefined;
}

/** The exclusive upper bound of a calendar day, so that day is included. */
export function utcDayEnd(date: string | undefined): Date | undefined {
  const start = utcDayStart(date);
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : undefined;
}
