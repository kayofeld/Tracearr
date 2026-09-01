/**
 * Replacement linking: event-witnessed remove+add pairs of the same media get
 * a replaces_library_item_id link; scan tombstones and pre-existing copies
 * never do. Run with: pnpm test:integration -- replacementLinking
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { librarySyncService } from '../../services/librarySync.js';
import { resetTestDb } from '@tracearr/test-utils/db';
import { createTestServer, createTestLibraryItem } from '@tracearr/test-utils/factories';

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

async function getItem(id: string) {
  const res = await db.execute(sql`
    SELECT removed_at, removed_source, replaces_library_item_id
    FROM library_items WHERE id = ${id}
  `);
  return res.rows[0] as {
    removed_at: Date | null;
    removed_source: string | null;
    replaces_library_item_id: string | null;
  };
}

describe('replacement linking', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it('tombstoneItemsByRatingKey stamps event provenance and links a fresh copy', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    const old = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60 * 48),
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(1),
    });

    await librarySyncService.tombstoneItemsByRatingKey(server.id, ['old-1080p']);

    const oldRow = await getItem(old.id);
    expect(oldRow.removed_at).not.toBeNull();
    expect(oldRow.removed_source).toBe('event');

    const freshRow = await getItem(fresh.id);
    expect(freshRow.replaces_library_item_id).toBe(old.id);
  });

  it('markItemsRemoved stamps scan provenance and the pair never links', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    const old = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60),
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(1),
    });

    await librarySyncService.markItemsRemoved(server.id, 'lib-1', ['old-1080p']);

    const oldRow = await getItem(old.id);
    expect(oldRow.removed_source).toBe('scan');

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(10));
    expect(linked).toBe(0);
    expect((await getItem(fresh.id)).replaces_library_item_id).toBeNull();
  });

  it('does not link a long-standing copy when its duplicate is deleted', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'copy-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60 * 48),
    });
    const survivor = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'copy-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(60 * 48),
    });

    await librarySyncService.tombstoneItemsByRatingKey(server.id, ['copy-1080p']);

    expect((await getItem(survivor.id)).replaces_library_item_id).toBeNull();
  });

  it('does not link when the tombstone falls outside the pair window', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60),
      removedAt: minutesAgo(30),
      removedSource: 'event',
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(1),
    });

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(90));
    expect(linked).toBe(0);
    expect((await getItem(fresh.id)).replaces_library_item_id).toBeNull();
  });

  it('newest event tombstone wins when several fall in the window', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-720p',
      mediaId,
      videoResolution: '720p',
      firstSeenAt: minutesAgo(60),
      removedAt: minutesAgo(5),
      removedSource: 'event',
    });
    const newest = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60),
      removedAt: minutesAgo(2),
      removedSource: 'event',
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(1),
    });

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(10));
    expect(linked).toBe(1);
    expect((await getItem(fresh.id)).replaces_library_item_id).toBe(newest.id);
  });

  it('links nothing when candidates exceed the rebuild guard', async () => {
    const server = await createTestServer({ type: 'emby' });
    const freshIds: string[] = [];
    for (let i = 0; i < 51; i++) {
      const mediaId = randomUUID();
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: `old-${i}`,
        mediaId,
        videoResolution: '720p',
        firstSeenAt: minutesAgo(60),
        removedAt: minutesAgo(2),
        removedSource: 'event',
        withoutVersion: true,
      });
      const fresh = await createTestLibraryItem({
        serverId: server.id,
        ratingKey: `new-${i}`,
        mediaId,
        videoResolution: '1080p',
        firstSeenAt: minutesAgo(1),
        withoutVersion: true,
      });
      freshIds.push(fresh.id);
    }

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(10));
    expect(linked).toBe(0);
    expect((await getItem(freshIds[0]!)).replaces_library_item_id).toBeNull();
  });

  it('does not link a re-key: identical resolution and byte size means nothing changed', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-key',
      mediaId,
      videoResolution: '1080p',
      fileSize: 1_932_735_283,
      firstSeenAt: minutesAgo(60),
      removedAt: minutesAgo(2),
      removedSource: 'event',
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-key',
      mediaId,
      videoResolution: '1080p',
      fileSize: 1_932_735_283,
      firstSeenAt: minutesAgo(1),
    });

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(10));
    expect(linked).toBe(0);
    expect((await getItem(fresh.id)).replaces_library_item_id).toBeNull();
  });

  it('one tombstone links at most one successor: closest first sighting wins', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    const old = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      fileSize: 2_000_000_000,
      firstSeenAt: minutesAgo(60),
      removedAt: minutesAgo(5),
      removedSource: 'event',
    });
    const closest = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      fileSize: 5_000_000_000,
      firstSeenAt: minutesAgo(4),
    });
    const later = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-1080p-webdl',
      mediaId,
      videoResolution: '1080p',
      fileSize: 3_000_000_000,
      firstSeenAt: minutesAgo(1),
    });

    const linked = await librarySyncService.linkEventReplacements(server.id, minutesAgo(10));
    expect(linked).toBe(1);
    expect((await getItem(closest.id)).replaces_library_item_id).toBe(old.id);
    expect((await getItem(later.id)).replaces_library_item_id).toBeNull();
  });

  it('never relinks an already-linked copy', async () => {
    const server = await createTestServer({ type: 'emby' });
    const mediaId = randomUUID();
    const first = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-720p',
      mediaId,
      videoResolution: '720p',
      firstSeenAt: minutesAgo(60),
    });
    const fresh = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'new-4k',
      mediaId,
      videoResolution: '4k',
      firstSeenAt: minutesAgo(1),
    });

    await librarySyncService.tombstoneItemsByRatingKey(server.id, ['old-720p']);
    expect((await getItem(fresh.id)).replaces_library_item_id).toBe(first.id);

    const second = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'old-1080p',
      mediaId,
      videoResolution: '1080p',
      firstSeenAt: minutesAgo(60),
    });
    await librarySyncService.tombstoneItemsByRatingKey(server.id, ['old-1080p']);

    expect((await getItem(fresh.id)).replaces_library_item_id).toBe(first.id);
    expect((await getItem(second.id)).removed_source).toBe('event');
  });
});
