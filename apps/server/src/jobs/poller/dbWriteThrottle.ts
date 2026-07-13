/**
 * Shared per-session DB write throttle for the periodic progress/lastSeenAt flush.
 * Used by both the poller and the SSE processor so a session tracked by either
 * path (or handed off between them) shares one last-write timestamp instead of
 * each path keeping its own clock and double-writing on overlap.
 */

import { DB_WRITE_FLUSH_INTERVAL_MS } from './types.js';

const lastDbWriteMap = new Map<string, number>();

/** Max deterministic jitter added on top of the base flush interval, in ms. */
const JITTER_RANGE_MS = 10_000;

function hashSessionId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Effective flush interval for a session: base interval plus deterministic jitter. */
export function getEffectiveFlushIntervalMs(sessionId: string): number {
  return DB_WRITE_FLUSH_INTERVAL_MS + (hashSessionId(sessionId) % JITTER_RANGE_MS);
}

/** Whether the periodic flush interval has elapsed for this session as of `now`. */
export function shouldFlushDbWrite(sessionId: string, now: number): boolean {
  const lastWrite = lastDbWriteMap.get(sessionId) ?? 0;
  return now - lastWrite >= getEffectiveFlushIntervalMs(sessionId);
}

/** Record that a DB write just happened for this session, resetting its flush clock. */
export function recordDbWrite(sessionId: string, now: number): void {
  lastDbWriteMap.set(sessionId, now);
}

/** Stop tracking a session's flush clock (on stop, media change, or grace-period sweep). */
export function clearDbWriteTracking(sessionId: string): void {
  lastDbWriteMap.delete(sessionId);
}

/** Clear all tracked flush clocks (poller shutdown, test reset). */
export function resetDbWriteThrottle(): void {
  lastDbWriteMap.clear();
}
