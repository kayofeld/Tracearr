/**
 * Shared hashing helpers
 */

import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest of a token or other opaque string.
 */
export function hashSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
