/**
 * PlayedStateSyncService integration tests (docs/architecture/emby-played-state-sync.md
 * §6.2). Runs the REAL upsert + prune + status-row SQL against a migrated database;
 * only the media-server HTTP client is mocked (createMediaServerClient), so the actual
 * per-user failure isolation - the one behavior a mocked-db unit test cannot prove -
 * executes against real played_states/played_state_sync_status rows.
 *
 * Covers:
 * - A failed user fetch does NOT prune that user's existing rows (failure isolation).
 * - A succeeded user's stale rows (older synced_at) ARE pruned.
 * - The server-level status row ends up 'partial' with accurate counts, and a Plex
 *   server writes no status row at all (capability-unsupported, ADR 0011).
 *
 * Run with:
 *   pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts playedStateSync.integration
 */
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mockGetUsers = vi.fn();
const mockGetPlayedItems = vi.fn();

vi.mock('../../src/services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(() => ({
    serverType: 'emby',
    getUsers: mockGetUsers,
    getPlayedItems: mockGetPlayedItems,
  })),
}));

import {
  createTestEmbyServer,
  createTestPlexServer,
  createTestUser,
  createTestServerUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { playedStates, playedStateSyncStatus } from '../../src/db/schema.js';
import { playedStateSyncService } from '../../src/services/playedStateSync.js';

async function seedPlayedState(opts: {
  serverId: string;
  serverUserId: string;
  ratingKey: string;
  syncedAt: Date;
}) {
  await db.insert(playedStates).values({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    ratingKey: opts.ratingKey,
    mediaType: 'movie',
    syncedAt: opts.syncedAt,
  });
}

describe('PlayedStateSyncService.syncServer', () => {
  it("never prunes a user whose fetch failed, but prunes a succeeded user's stale rows", async () => {
    const server = await createTestEmbyServer();
    const user1 = await createTestUser();
    const user2 = await createTestUser();
    const su1 = await createTestServerUser({
      userId: user1.id,
      serverId: server.id,
      externalId: 'ext-1',
    });
    const su2 = await createTestServerUser({
      userId: user2.id,
      serverId: server.id,
      externalId: 'ext-2',
    });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlayedState({
      serverId: server.id,
      serverUserId: su1.id,
      ratingKey: 'old-item-u1',
      syncedAt: oneHourAgo,
    });
    await seedPlayedState({
      serverId: server.id,
      serverUserId: su2.id,
      ratingKey: 'old-item-u2',
      syncedAt: oneHourAgo,
    });

    mockGetUsers.mockResolvedValue([
      { id: 'ext-1', username: 'u1', isAdmin: false },
      { id: 'ext-2', username: 'u2', isAdmin: false },
    ]);
    mockGetPlayedItems.mockImplementation((externalId: string) => {
      if (externalId === 'ext-1') {
        return Promise.resolve({
          items: [{ ratingKey: 'new-item-u1', mediaType: 'movie' as const }],
          rawCount: 1,
          totalCount: 1,
        });
      }
      if (externalId === 'ext-2') {
        return Promise.reject(new Error('emby unreachable'));
      }
      return Promise.resolve({ items: [], rawCount: 0, totalCount: 0 });
    });

    const result = await playedStateSyncService.syncServer(server.id);

    expect(result.status).toBe('partial');
    expect(result.usersTotal).toBe(2);
    expect(result.usersSynced).toBe(1);
    expect(result.error).toContain('emby unreachable');

    // u1 (succeeded): old row pruned, new row present.
    const u1Rows = await db
      .select({ ratingKey: playedStates.ratingKey })
      .from(playedStates)
      .where(eq(playedStates.serverUserId, su1.id));
    expect(u1Rows.map((r) => r.ratingKey).sort()).toEqual(['new-item-u1']);

    // u2 (failed): old row untouched - no prune ran for this user.
    const u2Rows = await db
      .select({ ratingKey: playedStates.ratingKey })
      .from(playedStates)
      .where(eq(playedStates.serverUserId, su2.id));
    expect(u2Rows.map((r) => r.ratingKey)).toEqual(['old-item-u2']);

    // Status row reflects the partial run with accurate counts.
    const [statusRow] = await db
      .select()
      .from(playedStateSyncStatus)
      .where(eq(playedStateSyncStatus.serverId, server.id));
    expect(statusRow?.status).toBe('partial');
    expect(statusRow?.usersTotal).toBe(2);
    expect(statusRow?.usersSynced).toBe(1);
    expect(statusRow?.completedAt).not.toBeNull();
  });

  it('reports success with accurate upsert/prune counts when every user succeeds', async () => {
    const server = await createTestEmbyServer();
    const user = await createTestUser();
    const su = await createTestServerUser({
      userId: user.id,
      serverId: server.id,
      externalId: 'ext-only',
    });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlayedState({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: 'stale-item',
      syncedAt: oneHourAgo,
    });

    mockGetUsers.mockResolvedValue([{ id: 'ext-only', username: 'u', isAdmin: false }]);
    mockGetPlayedItems.mockResolvedValue({
      items: [
        { ratingKey: 'movie-a', mediaType: 'movie' as const },
        { ratingKey: 'ep-a', mediaType: 'episode' as const, seriesRatingKey: 'show-a' },
      ],
      rawCount: 2,
      totalCount: 2,
    });

    const result = await playedStateSyncService.syncServer(server.id);

    expect(result.status).toBe('success');
    expect(result.usersSynced).toBe(1);
    expect(result.itemsUpserted).toBe(2);
    expect(result.itemsPruned).toBe(1); // 'stale-item' pruned

    const rows = await db
      .select({ ratingKey: playedStates.ratingKey })
      .from(playedStates)
      .where(eq(playedStates.serverUserId, su.id));
    expect(rows.map((r) => r.ratingKey).sort()).toEqual(['ep-a', 'movie-a']);
  });

  it('writes no status row for a Plex server (capability-unsupported)', async () => {
    const server = await createTestPlexServer();

    const result = await playedStateSyncService.syncServer(server.id);

    expect(result.status).toBe('unsupported');
    expect(mockGetUsers).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(playedStateSyncStatus)
      .where(eq(playedStateSyncStatus.serverId, server.id));
    expect(rows).toHaveLength(0);
  });
});
