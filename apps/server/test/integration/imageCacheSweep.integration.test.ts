/**
 * Sweep at scale against a real library_items table and synthetic cache files: 200k files, a quarter orphans, proving the expected set and the time/memory budget.
 * beforeEach, not beforeAll: the global setup's root beforeEach truncates library_items/servers after a nested beforeAll, so a beforeAll seed would be wiped before the test runs.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- imageCacheSweep
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import { posterCacheFileName } from '../../src/services/imageProxy.js';
import { sweepImageCache } from '../../src/services/imageCacheSweep.js';

const ITEMS = 150_000;
const REMOVED = 15_000; // subset of ITEMS with removed_at set; their files must survive
const ORPHANS = 50_000;
const PAYLOAD = Buffer.alloc(64, 1);

describe('imageCacheSweep at scale', () => {
  let dir: string;
  let serverId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracearr-sweep-'));
    const server = await createTestServer();
    serverId = server.id;
    const libraryId = 'lib-1';

    for (let start = 0; start < ITEMS; start += 5000) {
      const rows = Array.from({ length: Math.min(5000, ITEMS - start) }, (_, i) => {
        const n = start + i;
        return {
          serverId,
          libraryId,
          ratingKey: `sweep-${n}`,
          title: `Item ${n}`,
          mediaType: 'movie' as const,
          thumbPath: `/library/metadata/${n}/thumb/1`,
          removedAt: n < REMOVED ? new Date() : null,
        };
      });
      await db.insert(libraryItems).values(rows);
    }

    const writes: Promise<unknown>[] = [];
    const flush = async () => {
      await Promise.all(writes.splice(0));
    };
    for (let n = 0; n < ITEMS; n++) {
      const { fileName, shard } = posterCacheFileName(serverId, `/library/metadata/${n}/thumb/1`);
      writes.push(
        mkdir(join(dir, shard), { recursive: true }).then(() =>
          writeFile(join(dir, shard, fileName), PAYLOAD)
        )
      );
      if (writes.length >= 256) await flush();
    }
    for (let n = 0; n < ORPHANS; n++) {
      const hex = n.toString(16).padStart(16, '0');
      const shard = hex.slice(0, 2);
      writes.push(
        mkdir(join(dir, shard), { recursive: true }).then(() =>
          writeFile(join(dir, shard, `${hex}:vdeadbeef.webp`), PAYLOAD)
        )
      );
      if (writes.length >= 256) await flush();
    }
    await flush();
  }, 600_000);

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes exactly the orphans inside the budget', async () => {
    const before = process.memoryUsage().heapUsed;
    const result = await sweepImageCache({ cacheDir: dir, redis: null });
    const grew = process.memoryUsage().heapUsed - before;
    expect(result.deletedOrphans).toBe(ORPHANS);
    expect(result.files).toBe(ITEMS);
    expect(result.versionedFiles).toBe(ITEMS);
    expect(result.durationMs).toBeLessThan(60_000);
    expect(grew).toBeLessThan(300 * 1024 * 1024);
  }, 600_000);
});
