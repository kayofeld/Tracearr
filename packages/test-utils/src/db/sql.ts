/**
 * SQL literal helpers for the raw-SQL factories
 */

/** Escape a value for a SQL string literal; `null` becomes the NULL keyword. */
export function quote(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;
}
