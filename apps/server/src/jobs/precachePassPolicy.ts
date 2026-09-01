/**
 * Decision policy for the image precache pass that follows a library sync.
 * Split out from librarySyncQueue.ts so it's testable without wiring up
 * BullMQ, the DB pool, and the rest of the queue's dependencies.
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

// Backstop for the image precache pass: even with a watermark, walk every
// item at least this often so disk cache eviction (or a row mutated some
// other way that a watermark can't see) still gets healed. Chosen to match
// the sync's own periodic full-library verification cadence
// (FULL_SCAN_INTERVAL cycles at 12h in librarySync.ts ~= 3.5 days), so
// posters get re-verified about as often as the library data backing them.
export const PRECACHE_FULL_PASS_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
// Mirrors SYNC_SAFETY_MARGIN_MS in librarySync.ts: an item updated during the
// pass itself must not fall before the watermark stored for next time.
export const PRECACHE_WATERMARK_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export interface PrecachePassDecision {
  /** Null scopes the pass to a full walk; otherwise the stored watermark. */
  sinceUpdatedAt: string | null;
  /** Writes the stamps this pass consumed. Call it only once the pass is
   *  really queued - stamps that move for a pass nobody runs lose coverage. */
  commit: () => Promise<void>;
}

/**
 * Decide whether the image precache pass that follows a sync should be a full
 * walk, a watermark-limited walk, or skipped outright. Deciding writes
 * nothing: the caller enqueues the pass and then calls commit(), so a pass
 * that never queued leaves the watermark where the last one left it.
 *
 * Returns null when the pass should be skipped entirely: the sync touched
 * nothing (every library's isIncremental "no changes" path short-circuited
 * before calling upsertItems) and the periodic full-pass backstop isn't due,
 * so there is nothing a precache walk could find anyway.
 *
 * Without a Redis client there's no watermark state to read or write, so
 * this always requests a full pass - the same unconditional behavior the
 * precache job had before this optimization existed. The watermark is
 * persisted before the pass it scopes runs, so an incomplete pass leaves
 * its rows unwarmed until the backstop.
 */
export async function resolvePrecachePass(
  redis: Redis | null,
  serverId: string,
  triggeredBy: 'manual' | 'scheduled',
  hadChanges: boolean
): Promise<PrecachePassDecision | null> {
  if (!redis) return { sinceUpdatedAt: null, commit: () => Promise.resolve() };

  const lastFullStr = await redis.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(serverId));
  const lastFull = lastFullStr ? new Date(lastFullStr).getTime() : 0;
  // A corrupt/unparseable stored value must fail toward MORE work, same as a missing key.
  const dueForFullPass =
    triggeredBy === 'manual' ||
    !lastFullStr ||
    Number.isNaN(lastFull) ||
    Date.now() - lastFull > PRECACHE_FULL_PASS_INTERVAL_MS;

  if (!hadChanges && !dueForFullPass) {
    return null;
  }

  const sinceUpdatedAt = dueForFullPass
    ? null
    : await redis.get(REDIS_KEYS.LIBRARY_PRECACHE_WATERMARK(serverId));

  return {
    sinceUpdatedAt,
    commit: async () => {
      if (dueForFullPass) {
        await redis.set(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(serverId), new Date().toISOString());
      }
      const safeTimestamp = new Date(
        Date.now() - PRECACHE_WATERMARK_SAFETY_MARGIN_MS
      ).toISOString();
      await redis.set(REDIS_KEYS.LIBRARY_PRECACHE_WATERMARK(serverId), safeTimestamp);
    },
  };
}
