import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the periodic full-scan cycle logic in LibrarySyncService.
 */

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../jobs/heavyOpsLock.js', () => ({
  getHeavyOpsStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

import type { Redis } from 'ioredis';
import { LibrarySyncService, initLibrarySyncRedis } from '../librarySync.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { db } from '../../db/client.js';

const mockCreateClient = vi.mocked(createMediaServerClient);

function makeMockRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  } as unknown as Redis;
}

/**
 * Sets up db.select() to return the mock server on the first call and empty
 * arrays for all subsequent calls (getPreviousItemKeys, snapshot queries, etc).
 */
function setupDbSelectMocks(mockServer: {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin' | 'emby';
  url: string;
  token: string;
}) {
  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const whereResult = Promise.resolve([]);
        (whereResult as typeof whereResult & { limit: ReturnType<typeof vi.fn> }).limit = vi
          .fn()
          .mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          });
        (whereResult as typeof whereResult & { orderBy: ReturnType<typeof vi.fn> }).orderBy = vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
        return whereResult;
      }),
      limit: vi.fn().mockImplementation(() => {
        if (callCount === 1) return Promise.resolve([mockServer]);
        return Promise.resolve([]);
      }),
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      returning: vi.fn().mockResolvedValue([]),
    };
    return chain as never;
  });

  // selectDistinct resolves to empty — no orphaned libraries
  vi.mocked((db as any).selectDistinct).mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  }));

  // insert chain for snapshot creation
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'snap-1' }]),
    }),
  } as any);

  // delete chain
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  } as any);

  // transaction for upsertItems
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    return callback(tx);
  });
}

function makeMockClient(opts: { totalCount?: number; itemsSinceCount?: number } = {}) {
  const totalCount = opts.totalCount ?? 100;
  const itemsSinceCount = opts.itemsSinceCount ?? 0;

  return {
    serverType: 'plex' as const,
    getLibraries: vi.fn().mockResolvedValue([{ id: '1', name: 'Movies', type: 'movie' }]),
    getLibraryItems: vi.fn().mockResolvedValue({ items: [], totalCount }),
    getLibraryItemsSince: vi.fn().mockResolvedValue({
      items: Array.from({ length: itemsSinceCount }, (_, i) => ({
        ratingKey: String(i),
        title: `Item ${i}`,
        mediaType: 'movie',
        addedAt: new Date(),
        updatedAt: new Date(),
        fileSize: 1000000,
      })),
      totalCount: itemsSinceCount,
    }),
    getLibraryLeavesSince: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    getLibraryLeaves: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    getSessions: vi.fn(),
    getUsers: vi.fn(),
    testConnection: vi.fn(),
    terminateSession: vi.fn(),
  };
}

const TEST_SERVER = {
  id: 'srv-1',
  name: 'Test Plex',
  type: 'plex' as const,
  url: 'http://plex:32400',
  token: 'tok',
};

describe('LibrarySyncService full-scan cycle', () => {
  let service: LibrarySyncService;
  let mockRedis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LibrarySyncService();
    mockRedis = makeMockRedis();
    initLibrarySyncRedis(mockRedis);
    setupDbSelectMocks(TEST_SERVER);
  });

  it('uses incremental sync on first few cycles', async () => {
    const client = makeMockClient({ totalCount: 100, itemsSinceCount: 5 });
    mockCreateClient.mockReturnValue(client);

    // Simulate prior sync state (cycle 1, not at interval yet)
    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:cycle:srv-1:1', '1');

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).toHaveBeenCalled();
  });

  it('forces full scan when cycle reaches FULL_SCAN_INTERVAL', async () => {
    const client = makeMockClient({ totalCount: 100 });
    mockCreateClient.mockReturnValue(client);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:cycle:srv-1:1', '7');

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    expect(client.getLibraryItems).toHaveBeenCalled();
  });

  it('always forces full scan for manual triggers', async () => {
    const client = makeMockClient({ totalCount: 100 });
    mockCreateClient.mockReturnValue(client);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:cycle:srv-1:1', '1');

    await service.syncServer('srv-1', undefined, 'manual');

    expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
  });
});
