/**
 * Library Sync Queue - invalidateLibraryCaches tests
 *
 * QA found this key-pattern list was unguarded by any test: dropping
 * `LIBRARY_NEVER_WATCHED*` (or any other entry) from the invalidation list
 * survived the whole suite, so a "never watched" sync would keep serving a
 * stale cached payload for up to CACHE_TTL.LIBRARY_NEVER_WATCHED (1 hour)
 * after a rename/resync. Mirrors invalidateOmbiCaches's test pattern in
 * jobs/__tests__/ombiSyncQueue.test.ts: the function takes `redis` as a
 * parameter (not a module-level client), so it is unit-testable directly
 * without a live BullMQ worker/Redis connection.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

// librarySyncQueue.ts pulls in db/client.js (throws without DATABASE_URL) plus
// the BullMQ Queue/Worker machinery transitively via these modules. None of it
// runs at import time for invalidateLibraryCaches (Queue/Worker are only
// constructed inside init/start functions we never call here), but the module
// graph still needs mocking to import the file at all - mirrors
// jobs/__tests__/ombiSyncQueue.test.ts's mock set for its sibling queue module.
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('../../serverState.js', () => ({ isMaintenance: () => false }));
vi.mock('../../services/cache.js', () => ({ getPubSubService: vi.fn(() => null) }));
vi.mock('../../services/librarySync.js', () => ({
  librarySyncService: { syncServer: vi.fn() },
  initLibrarySyncRedis: vi.fn(),
}));
vi.mock('../maintenanceQueue.js', () => ({ enqueueMaintenanceJob: vi.fn() }));

import { invalidateLibraryCaches } from '../librarySyncQueue.js';

describe('invalidateLibraryCaches', () => {
  it('includes the LIBRARY_NEVER_WATCHED pattern so a rename/resync busts the never-watched cache', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidateLibraryCaches(redis, 'server-1');

    const calledPatterns = keys.mock.calls.map((call) => call[0] as string);
    expect(calledPatterns).toContain(`${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`);
  });

  it('deletes keys matching every pattern in the list', async () => {
    const keys = vi.fn((pattern: string) => {
      if (pattern === `${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*`) {
        return Promise.resolve(['never-watched:a', 'never-watched:b']);
      }
      if (pattern === `${REDIS_KEYS.LIBRARY_STALE}*`) {
        return Promise.resolve(['stale:a']);
      }
      return Promise.resolve([]);
    });
    const del = vi.fn().mockResolvedValue(3);
    const redis = { keys, del } as unknown as Redis;

    await invalidateLibraryCaches(redis, 'server-1');

    expect(del).toHaveBeenCalledWith('never-watched:a', 'never-watched:b');
    expect(del).toHaveBeenCalledWith('stale:a');
  });

  it('is a no-op when no matching keys exist', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidateLibraryCaches(redis, 'server-1');

    expect(del).not.toHaveBeenCalled();
  });
});
