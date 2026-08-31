/**
 * Canonical list-query contract.
 *
 * The list endpoints grew independently and diverged: four pagination styles,
 * five response envelopes, three names for the array key, and two conventions
 * for the sort params. This is the shape new list endpoints take, and the one
 * existing endpoints migrate onto a family at a time.
 *
 * `/users` is the first adopter.
 */

import { z } from 'zod';

/**
 * Sort params whitelisted to the fields an endpoint can actually order by.
 * `orderDir` stays optional so a route can pick a sensible direction per field
 * (names read A-Z, dates and scores lead with the most interesting end).
 */
export function listSortSchema<const TFields extends readonly [string, ...string[]]>(
  fields: TFields
) {
  return z.object({
    orderBy: z.enum(fields).default(fields[0]),
    orderDir: z.enum(['asc', 'desc']).optional(),
  });
}

/**
 * A calendar-date bound on a filter range. Both ends are optional and
 * independent: "joined before 2024" and "not seen since March" each set one
 * side only, which is why these are two bounds rather than one range object.
 */
export const listDateBoundSchema = z.iso.date().optional();

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface ListResponse<T> {
  data: T[];
  meta: ListMeta;
}

/** Page count is derived from meta, never sent over the wire. */
export function listPageCount(meta: Pick<ListMeta, 'pageSize' | 'total'>): number {
  return meta.pageSize > 0 ? Math.ceil(meta.total / meta.pageSize) : 0;
}
