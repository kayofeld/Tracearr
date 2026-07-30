/**
 * Played-State Sync Queue - invalidatePlayedStateCaches tests
 *
 * Mirrors jobs/__tests__/librarySyncQueue.test.ts's test for
 * invalidateLibraryCaches: the function takes `redis` as a parameter (not a
 * module-level client), so it is unit-testable directly without a live
 * BullMQ worker/Redis connection (design §5.3 - exported so the pattern list
 * itself is guarded by a test, not just exercised incidentally by a sync run).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

// playedStateSyncQueue.ts pulls in db/client.js (throws without DATABASE_URL)
// plus BullMQ Queue/Worker and services/playedStateSync.js transitively. None
// of it runs at import time for invalidatePlayedStateCaches (Queue/Worker are
// only constructed inside init/start functions never called here), but the
// module graph still needs mocking to import the file at all.
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('../../serverState.js', () => ({ isMaintenance: () => false }));
vi.mock('../../services/cache.js', () => ({ getPubSubService: vi.fn(() => null) }));
vi.mock('../../services/playedStateSync.js', () => ({
  playedStateSyncService: { syncServer: vi.fn() },
}));

import { invalidatePlayedStateCaches } from '../playedStateSyncQueue.js';

describe('invalidatePlayedStateCaches', () => {
  it('includes both LIBRARY_STALE and LIBRARY_NEVER_WATCHED patterns (design §5.3)', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidatePlayedStateCaches(redis, 'server-1');

    const calledPatterns = keys.mock.calls.map((call) => call[0] as string);
    expect(calledPatterns).toContain(`${REDIS_KEYS.LIBRARY_STALE}*`);
    expect(calledPatterns).toContain(`${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`);
  });

  it('deletes keys matching every pattern in the list', async () => {
    const keys = vi.fn((pattern: string) => {
      if (pattern === `${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`) {
        return Promise.resolve(['never-watched:a']);
      }
      if (pattern === `${REDIS_KEYS.LIBRARY_STALE}*`) {
        return Promise.resolve(['stale:a', 'stale:b']);
      }
      return Promise.resolve([]);
    });
    const del = vi.fn().mockResolvedValue(3);
    const redis = { keys, del } as unknown as Redis;

    await invalidatePlayedStateCaches(redis, 'server-1');

    expect(del).toHaveBeenCalledWith('never-watched:a');
    expect(del).toHaveBeenCalledWith('stale:a', 'stale:b');
  });

  it('is a no-op when no matching keys exist', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidatePlayedStateCaches(redis, 'server-1');

    expect(del).not.toHaveBeenCalled();
  });
});
