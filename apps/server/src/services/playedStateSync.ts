/**
 * Played-State Sync Service - Mirrors per-user played flags from Emby/Jellyfin
 *
 * Design: docs/architecture/emby-played-state-sync.md §6. ADRs: 0010 (mirror +
 * query semantics), 0011 (no-data vs never-watched representation).
 *
 * Full-mirror semantics per server run (like media_requests, ADR 0004): for
 * every user resolved on the server, page through every currently-played item
 * and upsert it, then prune rows from that user that weren't touched by this
 * run (removed items, un-marked plays). A user whose fetch fails keeps its
 * existing rows untouched - no prune - so a transient failure never makes an
 * item look never-watched again.
 *
 * Plex has no per-user played-state endpoint reachable with a single admin
 * token, so syncServer() returns immediately for Plex servers without writing
 * a status row - that keeps `played_state_sync_status` honest: "no row" means
 * "never attempted", not "attempted and failed".
 */

import { eq, and, lt, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, serverUsers, playedStates, playedStateSyncStatus } from '../db/schema.js';
import { createMediaServerClient, type MediaPlayedItem } from './mediaServer/index.js';
import type {
  PlayedStateSyncProgress,
  PlayedStateCapability,
  PlayedStateCoverage,
  PlayedStateServerCoverage,
  PlayedStateSyncStatusResponse,
} from '@tracearr/shared';

/** Items requested per page from getPlayedItems - bounds payload size (design §6.2). */
const PAGE_SIZE = 5000;

/** Rows upserted per batch. */
const UPSERT_BATCH_SIZE = 500;

/** Delay between users - matches librarySync.ts's BATCH_DELAY_MS posture (design §6.2/§6.3). */
const INTER_USER_DELAY_MS = 150;

export type OnProgressCallback = (progress: PlayedStateSyncProgress) => void;

/** Outcome of syncing one server, reported back to the queue worker for logging/testing. */
export interface PlayedStateSyncResult {
  serverId: string;
  /** 'unsupported' = Plex, no status row written. */
  status: 'success' | 'partial' | 'error' | 'unsupported';
  usersTotal: number;
  usersSynced: number;
  usersSkipped: number;
  itemsUpserted: number;
  itemsPruned: number;
  error: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlayedStateSyncService {
  /**
   * Sync played state for a single server.
   *
   * @param serverId - The server to sync
   * @param onProgress - Optional callback for progress updates (WS event)
   */
  async syncServer(
    serverId: string,
    onProgress?: OnProgressCallback
  ): Promise<PlayedStateSyncResult> {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    // Plex: capability-unsupported. No status row - "never synced" stays
    // honestly distinguishable from "attempted and failed" (ADR 0011).
    if (server.type === 'plex') {
      return {
        serverId,
        status: 'unsupported',
        usersTotal: 0,
        usersSynced: 0,
        usersSkipped: 0,
        itemsUpserted: 0,
        itemsPruned: 0,
        error: null,
      };
    }

    const runStart = new Date();
    const startedAtIso = runStart.toISOString();

    await this.upsertStatusRow(serverId, {
      status: 'running',
      startedAt: runStart,
      completedAt: null,
    });

    if (onProgress) {
      onProgress({
        serverId,
        serverName: server.name,
        status: 'running',
        totalUsers: 0,
        processedUsers: 0,
        itemsProcessed: 0,
        message: 'Starting played-state sync...',
        startedAt: startedAtIso,
      });
    }

    let client;
    try {
      client = createMediaServerClient({
        type: server.type,
        url: server.url,
        token: server.token,
        id: server.id,
        name: server.name,
      });
    } catch (error) {
      return this.finalizeError(serverId, server.name, runStart, error, onProgress);
    }

    if (!client.getPlayedItems) {
      // Defensive - the factory only returns clients that implement this for
      // non-plex types. Treated as a server-level error, not a silent no-op.
      return this.finalizeError(
        serverId,
        server.name,
        runStart,
        new Error(`${server.type} client does not implement getPlayedItems`),
        onProgress
      );
    }
    const getPlayedItems = client.getPlayedItems.bind(client);

    let mediaUsers;
    try {
      mediaUsers = await client.getUsers();
    } catch (error) {
      return this.finalizeError(serverId, server.name, runStart, error, onProgress);
    }

    // Resolve media-server users to server_users rows (server_id, external_id).
    const serverUserRows = await db
      .select({ id: serverUsers.id, externalId: serverUsers.externalId })
      .from(serverUsers)
      .where(eq(serverUsers.serverId, serverId));
    const externalIdToServerUserId = new Map(serverUserRows.map((r) => [r.externalId, r.id]));

    const resolvedUsers: Array<{ serverUserId: string; externalId: string }> = [];
    let usersSkipped = 0;
    for (const mediaUser of mediaUsers) {
      const serverUserId = externalIdToServerUserId.get(mediaUser.id);
      if (!serverUserId) {
        usersSkipped++;
        continue;
      }
      resolvedUsers.push({ serverUserId, externalId: mediaUser.id });
    }

    if (usersSkipped > 0) {
      console.warn(
        `[PlayedStateSync] Skipped ${usersSkipped} unresolvable user(s) for server ${server.name} ` +
          `(no matching server_users row yet - next user sync will pick them up)`
      );
    }

    const usersTotal = resolvedUsers.length;
    let usersSynced = 0;
    let itemsUpserted = 0;
    let itemsPruned = 0;
    let lastError: string | null = null;

    for (let i = 0; i < resolvedUsers.length; i++) {
      const user = resolvedUsers[i]!;

      if (onProgress) {
        onProgress({
          serverId,
          serverName: server.name,
          status: 'running',
          totalUsers: usersTotal,
          processedUsers: i,
          itemsProcessed: itemsUpserted,
          message: `Syncing user ${i + 1}/${usersTotal}...`,
          startedAt: startedAtIso,
        });
      }

      try {
        const userItemsUpserted = await this.syncUser(
          serverId,
          user.serverUserId,
          user.externalId,
          {
            getPlayedItems,
            runStart,
          }
        );
        itemsUpserted += userItemsUpserted;

        const pruned = await this.pruneUser(user.serverUserId, runStart);
        itemsPruned += pruned;

        usersSynced++;
      } catch (error) {
        lastError = PlayedStateSyncService.sanitizeError(
          error instanceof Error ? error.message : String(error)
        );
        console.error(
          `[PlayedStateSync] Failed to sync user ${user.externalId} on server ${server.name}:`,
          error
        );
        // No prune for this user - a failed fetch must never erase existing rows.
      }

      if (i < resolvedUsers.length - 1) {
        await delay(INTER_USER_DELAY_MS);
      }
    }

    const completedAt = new Date();

    // A run that resolved nobody has mirrored nothing, so it must report
    // 'error', not 'success' or 'partial': coverage counts both of those
    // (§4.2), and claiming coverage over an empty mirror produces exactly the
    // false "never watched" state ADR 0011 exists to prevent. Happens when the
    // played sync races ahead of the first user sync (fresh install, restored
    // backup).
    const resolvedNobody = usersTotal === 0 && usersSkipped > 0;
    const finalStatus: 'success' | 'partial' | 'error' = resolvedNobody
      ? 'error'
      : usersTotal > 0 && usersSynced < usersTotal
        ? 'partial'
        : 'success';

    const finalError = resolvedNobody
      ? `No media-server users could be resolved (${usersSkipped} skipped); run the user sync first.`
      : finalStatus === 'partial'
        ? lastError
        : null;

    await this.upsertStatusRow(serverId, {
      status: finalStatus,
      startedAt: runStart,
      completedAt,
      usersTotal,
      usersSynced,
      itemsUpserted,
      itemsPruned,
      error: finalError,
    });

    if (onProgress) {
      onProgress({
        serverId,
        serverName: server.name,
        // Track the persisted status rather than always reporting completion:
        // a run that resolved nobody finalizes as 'error', and announcing
        // "complete" for it would tell every socket consumer the opposite of
        // what the status row says.
        status: finalStatus === 'error' ? 'error' : 'complete',
        totalUsers: usersTotal,
        processedUsers: usersSynced,
        itemsProcessed: itemsUpserted,
        message:
          finalStatus === 'error'
            ? (finalError ?? 'Sync failed')
            : `Sync complete: ${usersSynced}/${usersTotal} users, ${itemsUpserted} items upserted, ${itemsPruned} pruned`,
        startedAt: startedAtIso,
        completedAt: completedAt.toISOString(),
        ...(finalStatus === 'error' && finalError ? { error: finalError } : {}),
      });
    }

    return {
      serverId,
      status: finalStatus,
      usersTotal,
      usersSynced,
      usersSkipped,
      itemsUpserted,
      itemsPruned,
      // Carry the error for both non-success outcomes; scoping this to
      // 'partial' alone silently dropped the zero-users-resolved reason.
      error: finalError,
    };
  }

  /**
   * Page through and upsert all played items for one user. Throws on the
   * first fetch failure - the caller treats that as "this user's sync
   * failed" and skips the prune.
   *
   * @returns Number of items upserted for this user
   */
  private async syncUser(
    serverId: string,
    serverUserId: string,
    userExternalId: string,
    ctx: {
      getPlayedItems: (
        userExternalId: string,
        options?: { offset?: number; limit?: number }
      ) => Promise<{ items: MediaPlayedItem[]; rawCount: number; totalCount: number }>;
      runStart: Date;
    }
  ): Promise<number> {
    let offset = 0;
    let totalUpserted = 0;

    while (true) {
      const { items, rawCount, totalCount } = await ctx.getPlayedItems(userExternalId, {
        offset,
        limit: PAGE_SIZE,
      });

      // Guard the loop bound itself, not just the empty case: a non-finite
      // rawCount would make `offset += rawCount` NaN and spin forever, hanging
      // the worker. Cheaper to stop early than to hang.
      if (!Number.isFinite(rawCount) || rawCount <= 0) break;

      // Drop duplicate rating keys within a page: a single INSERT cannot touch
      // the same conflict target twice ("cannot affect row a second time"),
      // and that would fail the whole user on every run.
      const seen = new Set<string>();
      const deduped = items.filter((item) => {
        if (seen.has(item.ratingKey)) return false;
        seen.add(item.ratingKey);
        return true;
      });

      for (let i = 0; i < deduped.length; i += UPSERT_BATCH_SIZE) {
        const batch = deduped.slice(i, i + UPSERT_BATCH_SIZE);
        await this.upsertPlayedItems(serverId, serverUserId, batch, ctx.runStart);
        totalUpserted += batch.length;
      }

      // Advance on the raw row count, never the parsed one - StartIndex pages
      // raw rows, so a row dropped by the parser would otherwise shift the
      // offset and end the loop early, stranding the tail to be pruned.
      offset += rawCount;
      if (offset >= totalCount || rawCount < PAGE_SIZE) break;
    }

    return totalUpserted;
  }

  /**
   * Bulk upsert one batch of played items for one user.
   * Conflict target: (server_user_id, rating_key) - played_states_user_rating_unique.
   */
  async upsertPlayedItems(
    serverId: string,
    serverUserId: string,
    items: MediaPlayedItem[],
    runStart: Date
  ): Promise<{ skippedEmpty: number }> {
    if (items.length === 0) return { skippedEmpty: 0 };

    let skippedEmpty = 0;
    const rows: Array<{
      serverId: string;
      serverUserId: string;
      ratingKey: string;
      mediaType: string;
      seriesRatingKey: string | null;
      playedAt: Date | null;
      playCount: number | null;
      syncedAt: Date;
    }> = [];

    for (const item of items) {
      if (!item.ratingKey) {
        skippedEmpty++;
        continue;
      }
      rows.push({
        serverId,
        serverUserId,
        ratingKey: item.ratingKey,
        mediaType: item.mediaType,
        seriesRatingKey: item.seriesRatingKey ?? null,
        playedAt: item.playedAt ?? null,
        playCount: item.playCount ?? null,
        syncedAt: runStart,
      });
    }

    if (rows.length === 0) return { skippedEmpty };

    await db
      .insert(playedStates)
      .values(rows)
      .onConflictDoUpdate({
        target: [playedStates.serverUserId, playedStates.ratingKey],
        set: {
          mediaType: sql`excluded.media_type`,
          seriesRatingKey: sql`excluded.series_rating_key`,
          playedAt: sql`excluded.played_at`,
          playCount: sql`excluded.play_count`,
          syncedAt: sql`excluded.synced_at`,
          updatedAt: new Date(),
        },
      });

    return { skippedEmpty };
  }

  /**
   * Delete rows for a user that weren't touched by this run - only called
   * after that user's fetch succeeded (design §6.2, §4.1 "items disappearing").
   */
  private async pruneUser(serverUserId: string, runStart: Date): Promise<number> {
    const deleted = await db
      .delete(playedStates)
      .where(and(eq(playedStates.serverUserId, serverUserId), lt(playedStates.syncedAt, runStart)))
      .returning({ id: playedStates.id });

    return deleted.length;
  }

  /** Upsert the one-row-per-server status row (played_state_sync_status). */
  private async upsertStatusRow(
    serverId: string,
    values: {
      status: string;
      startedAt: Date;
      completedAt: Date | null;
      usersTotal?: number;
      usersSynced?: number;
      itemsUpserted?: number;
      itemsPruned?: number;
      error?: string | null;
    }
  ): Promise<void> {
    await db
      .insert(playedStateSyncStatus)
      .values({
        serverId,
        status: values.status,
        startedAt: values.startedAt,
        completedAt: values.completedAt,
        usersTotal: values.usersTotal ?? 0,
        usersSynced: values.usersSynced ?? 0,
        itemsUpserted: values.itemsUpserted ?? 0,
        itemsPruned: values.itemsPruned ?? 0,
        error: values.error ?? null,
      })
      .onConflictDoUpdate({
        target: playedStateSyncStatus.serverId,
        set: {
          status: values.status,
          startedAt: values.startedAt,
          completedAt: values.completedAt,
          usersTotal: values.usersTotal ?? 0,
          usersSynced: values.usersSynced ?? 0,
          itemsUpserted: values.itemsUpserted ?? 0,
          itemsPruned: values.itemsPruned ?? 0,
          error: values.error ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Strip URLs out of anything persisted to played_state_sync_status.error or
   * pushed over the progress socket.
   *
   * The status row is readable by any user with access to the server and is
   * broadcast to connected clients, while most upstream failures are shaped by
   * the media server rather than by us. Node's fetch, for one, puts the whole
   * request URL into "Failed to parse URL from ..." - which would publish the
   * internal server address and a user's external id. This repo has shipped a
   * raw URL in an error body before, so the column gets a hard rule instead of
   * a case-by-case judgement.
   */
  private static sanitizeError(message: string): string {
    return message.replace(/\bhttps?:\/\/\S+/gi, '[url removed]');
  }

  /** Server-level failure path: stamp status='error' and report it. */
  private async finalizeError(
    serverId: string,
    serverName: string,
    runStart: Date,
    error: unknown,
    onProgress?: OnProgressCallback
  ): Promise<PlayedStateSyncResult> {
    const message = PlayedStateSyncService.sanitizeError(
      error instanceof Error ? error.message : String(error)
    );
    const completedAt = new Date();

    console.error(`[PlayedStateSync] Server-level failure for ${serverName}:`, error);

    await this.upsertStatusRow(serverId, {
      status: 'error',
      startedAt: runStart,
      completedAt,
      usersTotal: 0,
      usersSynced: 0,
      itemsUpserted: 0,
      itemsPruned: 0,
      error: message,
    });

    if (onProgress) {
      onProgress({
        serverId,
        serverName,
        status: 'error',
        totalUsers: 0,
        processedUsers: 0,
        itemsProcessed: 0,
        message: `Sync failed: ${message}`,
        startedAt: runStart.toISOString(),
        completedAt: completedAt.toISOString(),
        error: message,
      });
    }

    return {
      serverId,
      status: 'error',
      usersTotal: 0,
      usersSynced: 0,
      usersSkipped: 0,
      itemsUpserted: 0,
      itemsPruned: 0,
      error: message,
    };
  }

  /** Get server configuration from database */
  private async getServer(serverId: string): Promise<{
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
    url: string;
    token: string;
  } | null> {
    const [server] = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        token: servers.token,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    return server ?? null;
  }
}

// Export singleton instance
export const playedStateSyncService = new PlayedStateSyncService();

// ============================================================================
// Coverage + status readers - shared by GET /played-state/status (§7.1) and
// the playedStateCoverage field on neverWatched.ts/stale.ts (§5.3, §7.3). One
// query shape, two view shapes, so the two endpoints can never quietly drift
// on what counts as "synced" for a server.
// ============================================================================

/** Per-server played-state row, joined from `servers` + `played_state_sync_status`. */
interface ServerPlayedStateInfo {
  serverId: string;
  serverName: string;
  serverType: 'plex' | 'jellyfin' | 'emby';
  /** null = played_state_sync_status has no row for this server (never run). */
  status: 'running' | 'success' | 'partial' | 'error' | null;
  startedAt: Date | null;
  completedAt: Date | null;
  usersTotal: number;
  usersSynced: number;
  itemsUpserted: number;
  itemsPruned: number;
  error: string | null;
}

/**
 * One row per server in scope, LEFT JOINed against its (possibly absent)
 * played_state_sync_status row.
 *
 * @param serverIds - Servers to include. `undefined` = every server
 *   (owner, no filter). An explicitly empty array is the caller's job to
 *   short-circuit before calling this (no rows to join against).
 */
async function getServerPlayedStateInfo(serverIds?: string[]): Promise<ServerPlayedStateInfo[]> {
  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
      status: playedStateSyncStatus.status,
      startedAt: playedStateSyncStatus.startedAt,
      completedAt: playedStateSyncStatus.completedAt,
      usersTotal: playedStateSyncStatus.usersTotal,
      usersSynced: playedStateSyncStatus.usersSynced,
      itemsUpserted: playedStateSyncStatus.itemsUpserted,
      itemsPruned: playedStateSyncStatus.itemsPruned,
      error: playedStateSyncStatus.error,
    })
    .from(servers)
    .leftJoin(playedStateSyncStatus, eq(playedStateSyncStatus.serverId, servers.id))
    .where(serverIds ? inArray(servers.id, serverIds) : undefined);

  return rows.map((r) => ({
    serverId: r.serverId,
    serverName: r.serverName,
    serverType: r.serverType,
    status: (r.status as ServerPlayedStateInfo['status']) ?? null,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    usersTotal: r.usersTotal ?? 0,
    usersSynced: r.usersSynced ?? 0,
    itemsUpserted: r.itemsUpserted ?? 0,
    itemsPruned: r.itemsPruned ?? 0,
    error: r.error ?? null,
  }));
}

/**
 * Build the `PlayedStateCoverage` object embedded in NeverWatchedStatsResponse
 * and StaleResponse (§7.3). "Coverage exists" for a server = a status row with
 * status IN ('success','partial') AND completed_at IS NOT NULL (§4.2).
 *
 * @param serverIds - Servers in the response scope. `undefined` = all
 *   servers. Pass an empty array only if you want an honestly-empty,
 *   `full: false` coverage object without touching the database.
 */
export async function buildPlayedStateCoverage(serverIds?: string[]): Promise<PlayedStateCoverage> {
  if (serverIds?.length === 0) {
    return { servers: [], full: false };
  }

  const rows = await getServerPlayedStateInfo(serverIds);

  const coverageServers: PlayedStateServerCoverage[] = rows.map((r) => {
    const capability: PlayedStateCapability = r.serverType === 'plex' ? 'unsupported' : 'supported';
    const hasCoverage =
      (r.status === 'success' || r.status === 'partial') && r.completedAt !== null;

    return {
      serverId: r.serverId,
      serverName: r.serverName,
      capability,
      lastSyncedAt: hasCoverage ? r.completedAt!.toISOString() : null,
    };
  });

  const full =
    coverageServers.length > 0 &&
    coverageServers.every((s) => s.capability === 'supported' && s.lastSyncedAt !== null);

  return { servers: coverageServers, full };
}

/**
 * Build the response for GET /api/v1/library/played-state/status (§7.1).
 *
 * @param serverIds - Servers in scope (per resolveServerIds). `undefined` =
 *   all servers.
 */
export async function getPlayedStateSyncStatusResponse(
  serverIds?: string[]
): Promise<PlayedStateSyncStatusResponse> {
  if (serverIds?.length === 0) {
    return { servers: [] };
  }

  const rows = await getServerPlayedStateInfo(serverIds);

  return {
    servers: rows.map((r) => ({
      serverId: r.serverId,
      serverName: r.serverName,
      capability: r.serverType === 'plex' ? 'unsupported' : 'supported',
      status: r.status ?? 'never_run',
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      usersTotal: r.usersTotal,
      usersSynced: r.usersSynced,
      itemsUpserted: r.itemsUpserted,
      itemsPruned: r.itemsPruned,
      error: r.error,
    })),
  };
}
