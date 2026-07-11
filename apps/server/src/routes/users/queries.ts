/** Shared User Query Functions **/

import type { UserDevice, AuthUser } from '@tracearr/shared';
import { sql, eq, and, inArray } from 'drizzle-orm';
import type { db as defaultDb } from '../../db/client.js';
import { serverUsers } from '../../db/schema.js';
import { buildServerAccessCondition, hasServerAccess } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

/**
 * All server_user ids belonging to a person's identity that the caller can
 * access. Always scoped by the caller's accessible servers (owners see every
 * sibling account, everyone else only their own accessible servers) so an
 * identity-wide query can never surface accounts on servers the caller
 * doesn't have access to.
 */
export async function resolveAccessibleServerUserIdsForIdentity(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserId: string
): Promise<string[]> {
  return resolveAccessibleServerUserIdsForIdentities(dbOrTx, authUser, [identityUserId]);
}

/**
 * Batched version of resolveAccessibleServerUserIdsForIdentity - the union of
 * every accessible server_user id across all given identities in a single
 * query. An identity with no accessible account under the caller's server
 * access contributes nothing to the union (fail-closed), same as the
 * singular resolver.
 */
export async function resolveAccessibleServerUserIdsForIdentities(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserIds: string[]
): Promise<string[]> {
  if (identityUserIds.length === 0) return [];

  const accessCondition = buildServerAccessCondition(authUser, serverUsers.serverId);
  const where = accessCondition
    ? and(inArray(serverUsers.userId, identityUserIds), accessCondition)
    : inArray(serverUsers.userId, identityUserIds);

  const rows = await dbOrTx.select({ id: serverUsers.id }).from(serverUsers).where(where);
  return rows.map((row) => row.id);
}

/**
 * Resolve the set of server_user ids a per-account endpoint (anchored on
 * `:id`) should query against: just `[id]` by default, or every accessible
 * sibling account under the same identity when `scope=identity` is set.
 */
export async function resolveIdentityScopedServerUserIds(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  id: string,
  scope: 'identity' | undefined
): Promise<
  | { error: 'notFound' }
  | { error: 'forbidden' }
  | { serverUser: { id: string; serverId: string; userId: string }; ids: string[] }
> {
  const rows = await dbOrTx
    .select({ id: serverUsers.id, serverId: serverUsers.serverId, userId: serverUsers.userId })
    .from(serverUsers)
    .where(eq(serverUsers.id, id))
    .limit(1);

  const serverUser = rows[0];
  if (!serverUser) {
    return { error: 'notFound' };
  }
  if (!hasServerAccess(authUser, serverUser.serverId)) {
    return { error: 'forbidden' };
  }
  if (scope !== 'identity') {
    return { serverUser, ids: [id] };
  }

  const ids = await resolveAccessibleServerUserIdsForIdentity(dbOrTx, authUser, serverUser.userId);
  // The anchor account is always part of its own identity and already passed
  // the access check above, so this can't come back empty in practice.
  return { serverUser, ids: ids.length > 0 ? ids : [id] };
}

/**
 * Build a `<columnRef> = ANY(...)` SQL fragment for a raw query.
 */
export function serverUserIdAnyFragment(ids: string[], columnRef = 'server_user_id') {
  return sql`${sql.raw(columnRef)} = ANY(${uuidArraySql(ids)})`;
}

interface DeviceSessionRow {
  device_id: string | null;
  player_name: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  started_at: Date;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
}

/**
 * Query deduplicated device sessions and aggregate into UserDevice[].
 * Uses DISTINCT ON to collapse pause/resume chains into one row per play,
 * then groups by device key with per-device location breakdowns.
 */
export async function queryUserDevices(
  dbOrTx: DbOrTx,
  serverUserIds: string | string[]
): Promise<UserDevice[]> {
  const ids = Array.isArray(serverUserIds) ? serverUserIds : [serverUserIds];
  const result = await dbOrTx.execute(sql`
    SELECT DISTINCT ON (COALESCE(reference_id, id))
      device_id, player_name, product, device, platform, started_at,
      geo_city, geo_region, geo_country
    FROM sessions
    WHERE ${serverUserIdAnyFragment(ids)}
    ORDER BY COALESCE(reference_id, id), started_at DESC
  `);

  // Raw SQL returns timestamps as strings — coerce to Date for comparisons
  const sessionData = (result.rows as unknown as DeviceSessionRow[]).map((r) => ({
    ...r,
    started_at: new Date(r.started_at),
  }));

  const deviceMap = new Map<
    string,
    {
      deviceId: string | null;
      playerName: string | null;
      product: string | null;
      device: string | null;
      platform: string | null;
      sessionCount: number;
      lastSeenAt: Date;
      locationMap: Map<
        string,
        {
          city: string | null;
          region: string | null;
          country: string | null;
          sessionCount: number;
          lastSeenAt: Date;
        }
      >;
    }
  >();

  for (const session of sessionData) {
    const key =
      session.device_id ??
      session.player_name ??
      `${session.product ?? 'unknown'}-${session.device ?? 'unknown'}-${session.platform ?? 'unknown'}`;

    const existing = deviceMap.get(key);
    if (existing) {
      existing.sessionCount++;
      if (session.started_at > existing.lastSeenAt) {
        existing.lastSeenAt = session.started_at;
        existing.playerName = session.player_name ?? existing.playerName;
        existing.product = session.product ?? existing.product;
        existing.device = session.device ?? existing.device;
        existing.platform = session.platform ?? existing.platform;
      }

      const locKey = `${session.geo_city ?? ''}-${session.geo_region ?? ''}-${session.geo_country ?? ''}`;
      const existingLoc = existing.locationMap.get(locKey);
      if (existingLoc) {
        existingLoc.sessionCount++;
        if (session.started_at > existingLoc.lastSeenAt) {
          existingLoc.lastSeenAt = session.started_at;
        }
      } else {
        existing.locationMap.set(locKey, {
          city: session.geo_city,
          region: session.geo_region,
          country: session.geo_country,
          sessionCount: 1,
          lastSeenAt: session.started_at,
        });
      }
    } else {
      const locationMap = new Map<
        string,
        {
          city: string | null;
          region: string | null;
          country: string | null;
          sessionCount: number;
          lastSeenAt: Date;
        }
      >();
      const locKey = `${session.geo_city ?? ''}-${session.geo_region ?? ''}-${session.geo_country ?? ''}`;
      locationMap.set(locKey, {
        city: session.geo_city,
        region: session.geo_region,
        country: session.geo_country,
        sessionCount: 1,
        lastSeenAt: session.started_at,
      });

      deviceMap.set(key, {
        deviceId: session.device_id,
        playerName: session.player_name,
        product: session.product,
        device: session.device,
        platform: session.platform,
        sessionCount: 1,
        lastSeenAt: session.started_at,
        locationMap,
      });
    }
  }

  return Array.from(deviceMap.values())
    .map((dev) => ({
      deviceId: dev.deviceId,
      playerName: dev.playerName,
      product: dev.product,
      device: dev.device,
      platform: dev.platform,
      sessionCount: dev.sessionCount,
      lastSeenAt: dev.lastSeenAt,
      locations: Array.from(dev.locationMap.values()).sort(
        (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
      ),
    }))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}
