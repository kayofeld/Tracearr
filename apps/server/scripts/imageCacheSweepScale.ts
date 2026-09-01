#!/usr/bin/env tsx
/**
 * Same build as test/integration/imageCacheSweep.integration.test.ts, run at
 * ten times the scale (750k library_items rows, 250k orphan files) to prove
 * the sweep's time and memory budget hold well past what a real install sees.
 *
 * Run: pnpm --filter @tracearr/server exec tsx scripts/imageCacheSweepScale.ts
 *
 * WARNING: writes up to 750,000 rows into the database at DATABASE_URL and
 * deletes them again afterwards (WHERE rating_key LIKE 'sweep-scale-%'). Do
 * not point this at a database you care about - run it against the
 * throwaway stack instead:
 *   docker compose -f docker/docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://test:test@localhost:5433/tracearr_test \
 *     pnpm --filter @tracearr/server exec tsx scripts/imageCacheSweepScale.ts
 *
 * Uses lib/bootstrap.ts's loadRuntime() (not static src/ imports) because
 * tsconfig.scripts.json's rootDir is scoped to scripts/ - see its docstring.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, like } from 'drizzle-orm';
import { loadRuntime } from './lib/bootstrap.ts';

const ITEMS = 750_000;
const REMOVED = 75_000; // subset of ITEMS with removed_at set; their files must survive
const ORPHANS = 250_000;
const PAYLOAD = Buffer.alloc(64, 1);

async function main() {
  const { db, closeDatabase, libraryItems, servers, posterCacheFileName, sweepImageCache } =
    await loadRuntime();

  const dir = await mkdtemp(join(tmpdir(), 'tracearr-sweep-scale-'));
  console.log(`cache dir: ${dir}`);

  try {
    const [server] = await db
      .insert(servers)
      .values({
        name: 'sweep-scale',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'sweep-scale-token',
      })
      .returning({ id: servers.id });
    if (!server) throw new Error('server insert returned no row');
    const serverId = server.id as string;
    const libraryId = 'lib-1';

    console.log(`inserting ${ITEMS} library_items rows...`);
    for (let start = 0; start < ITEMS; start += 5000) {
      const rows = Array.from({ length: Math.min(5000, ITEMS - start) }, (_, i) => {
        const n = start + i;
        return {
          serverId,
          libraryId,
          ratingKey: `sweep-scale-${n}`,
          title: `Item ${n}`,
          mediaType: 'movie' as const,
          thumbPath: `/library/metadata/${n}/thumb/1`,
          removedAt: n < REMOVED ? new Date() : null,
        };
      });
      await db.insert(libraryItems).values(rows);
    }

    console.log(`writing ${ITEMS} versioned files and ${ORPHANS} orphan files...`);
    const writes: Promise<unknown>[] = [];
    const flush = async () => {
      await Promise.all(writes.splice(0));
    };
    for (let n = 0; n < ITEMS; n++) {
      const { fileName, shard } = posterCacheFileName(
        serverId,
        `/library/metadata/${n}/thumb/1`
      ) as { fileName: string; shard: string };
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

    console.log('sweeping...');
    const before = process.memoryUsage().heapUsed;
    const result = (await sweepImageCache({ cacheDir: dir, redis: null })) as {
      files: number;
      deletedOrphans: number;
      durationMs: number;
    };
    const heapGrewBytes = process.memoryUsage().heapUsed - before;

    console.log(
      JSON.stringify(
        {
          files: result.files,
          deletedOrphans: result.deletedOrphans,
          durationMs: result.durationMs,
          heapGrewBytes,
        },
        null,
        2
      )
    );
  } finally {
    console.log('cleaning up...');
    await db.delete(libraryItems).where(like(libraryItems.ratingKey, 'sweep-scale-%'));
    await db.delete(servers).where(eq(servers.token, 'sweep-scale-token'));
    await rm(dir, { recursive: true, force: true });
    await closeDatabase();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
