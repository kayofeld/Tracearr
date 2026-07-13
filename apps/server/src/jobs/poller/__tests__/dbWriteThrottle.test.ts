import { beforeEach, describe, expect, it } from 'vitest';
import { DB_WRITE_FLUSH_INTERVAL_MS } from '../types.js';
import {
  clearDbWriteTracking,
  getEffectiveFlushIntervalMs,
  recordDbWrite,
  resetDbWriteThrottle,
  shouldFlushDbWrite,
} from '../dbWriteThrottle.js';

describe('dbWriteThrottle', () => {
  beforeEach(() => {
    resetDbWriteThrottle();
  });

  describe('getEffectiveFlushIntervalMs (jitter)', () => {
    it('never exceeds base interval + 10s', () => {
      const ids = ['a', 'b', 'c', 'session-1', 'session-2', randomLikeId(1), randomLikeId(2)];
      for (const id of ids) {
        const interval = getEffectiveFlushIntervalMs(id);
        expect(interval).toBeGreaterThanOrEqual(DB_WRITE_FLUSH_INTERVAL_MS);
        expect(interval).toBeLessThan(DB_WRITE_FLUSH_INTERVAL_MS + 10_000);
      }
    });

    it('is deterministic for a given session id', () => {
      const id = 'session-deterministic';
      expect(getEffectiveFlushIntervalMs(id)).toBe(getEffectiveFlushIntervalMs(id));
    });

    it('differs between different session ids', () => {
      const intervalA = getEffectiveFlushIntervalMs('session-aaaa');
      const intervalB = getEffectiveFlushIntervalMs('session-bbbb');
      expect(intervalA).not.toBe(intervalB);
    });

    function randomLikeId(n: number): string {
      return `11111111-1111-1111-1111-11111111111${n}`;
    }
  });

  describe('shouldFlushDbWrite', () => {
    it('is true for a session that has never written', () => {
      expect(shouldFlushDbWrite('new-session', Date.now())).toBe(true);
    });

    it('is false immediately after a recorded write', () => {
      const now = Date.now();
      recordDbWrite('sess-1', now);
      expect(shouldFlushDbWrite('sess-1', now + 1000)).toBe(false);
    });

    it('is true once the effective interval (with jitter) elapses', () => {
      const now = Date.now();
      recordDbWrite('sess-1', now);
      const interval = getEffectiveFlushIntervalMs('sess-1');
      expect(shouldFlushDbWrite('sess-1', now + interval - 1)).toBe(false);
      expect(shouldFlushDbWrite('sess-1', now + interval)).toBe(true);
    });

    it('tracks sessions independently', () => {
      const now = Date.now();
      recordDbWrite('sess-1', now);
      expect(shouldFlushDbWrite('sess-2', now + 1000)).toBe(true);
    });
  });

  describe('clearDbWriteTracking / resetDbWriteThrottle', () => {
    it('clearing a session resets it to "never written"', () => {
      const now = Date.now();
      recordDbWrite('sess-1', now);
      clearDbWriteTracking('sess-1');
      expect(shouldFlushDbWrite('sess-1', now + 1000)).toBe(true);
    });

    it('reset clears every tracked session', () => {
      const now = Date.now();
      recordDbWrite('sess-1', now);
      recordDbWrite('sess-2', now);
      resetDbWriteThrottle();
      expect(shouldFlushDbWrite('sess-1', now + 1000)).toBe(true);
      expect(shouldFlushDbWrite('sess-2', now + 1000)).toBe(true);
    });
  });
});
