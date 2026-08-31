/**
 * Driver-level Postgres error inspection, shared by the routes that answer one
 * with a status code instead of a 500.
 */

/** Postgres unique_violation. drizzle wraps the driver error, so the code can sit one level down. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  return err.code === '23505' || err.cause?.code === '23505';
}
