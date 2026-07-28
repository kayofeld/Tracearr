/**
 * Library Stale Content Route
 *
 * GET /stale - Identify unwatched or rarely-watched content
 *
 * Categories:
 * - never_watched: Content added but never played (no sessions)
 * - stale: Content watched but not revisited in N days
 *
 * Uses LEFT JOIN with sessions table to determine watch history,
 * with configurable staleness threshold (default 90 days).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStaleQuerySchema,
  type LibraryStaleQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getSettings } from '../../services/settings.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Category for stale content */
type StaleCategory = 'never_watched' | 'stale';

/**
 * Requester attribution from the Ombi connector (mirrors
 * `@tracearr/shared`'s `StaleItemRequestedBy` - contract §7; kept in sync by
 * hand since this route re-declares its response shapes locally rather than
 * importing them). Null when the connector is unconfigured, the item matched
 * no request, or the request is unattributed to a Tracearr user (then
 * ombiUsername still identifies the raw requester).
 */
interface StaleItemRequestedBy {
  userId: string | null;
  username: string | null;
  ombiUsername: string;
  ombiAlias: string | null;
  requestedAt: string;
  otherRequesterCount: number;
  source: 'ombi';
}

/** Individual stale content item */
interface StaleItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string;
  libraryName: string;
  title: string;
  mediaType: string;
  year: number | null;
  fileSize: number | null;
  resolution: string | null;
  addedAt: string;
  lastWatched: string | null;
  watchCount: number;
  category: StaleCategory;
  daysStale: number;
  /** Ombi requester attribution. Additive: null when the connector is off or nothing matched. */
  requestedBy: StaleItemRequestedBy | null;
}

/** Summary statistics for stale content */
interface StaleSummary {
  neverWatched: { count: number; sizeBytes: number };
  stale: { count: number; sizeBytes: number };
  total: { count: number; sizeBytes: number };
  threshold: { days: number };
}

/** Full response for stale content endpoint */
interface StaleResponse {
  items: StaleItem[];
  summary: StaleSummary;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row from database for items */
interface RawStaleItemRow {
  id: string;
  server_id: string;
  server_name: string;
  library_id: string;
  library_name: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size: string | null;
  video_resolution: string | null;
  added_at: string;
  last_watched: string | null;
  watch_count: string;
  category: StaleCategory;
  days_stale: string;
  // Ombi attribution columns - always present in the row shape (NULL/0 literals
  // when the connector is unconfigured, so mapping logic never branches per-row).
  request_user_id: string | null;
  request_username: string | null;
  request_ombi_username: string | null;
  request_ombi_alias: string | null;
  request_requested_at: string | null;
  request_distinct_requester_count: number;
}

/** Raw row from database for summary */
interface RawSummaryRow {
  never_watched_count: string;
  stale_count: string;
  never_watched_bytes: string;
  stale_bytes: string;
  total_stale_items: string;
  total_stale_bytes: string;
}

/**
 * Match condition joining a paginated stale item (`pi`, from the `paginated_items`
 * CTE - carries imdb_id/tmdb_id/tvdb_id/media_type) to an `ombi_requests` row
 * under the given alias. Mirrors the /stats/requesters join and ADR 0003:
 * imdb -> tmdb -> tvdb precedence, no title fallback (wrong attribution is worse
 * than none). TV requests (`media_type = 'tv'`) match the SHOW item.
 */
function buildRequesterMatchCondition(requestAlias: string): SQL {
  const r = sql.raw(requestAlias);
  return sql`(
    (pi.media_type = 'movie' AND ${r}.media_type = 'movie')
    OR (pi.media_type = 'show' AND ${r}.media_type = 'tv')
  )
  AND (
    (pi.imdb_id IS NOT NULL AND pi.imdb_id <> '' AND ${r}.imdb_id = pi.imdb_id)
    OR (pi.tmdb_id IS NOT NULL AND ${r}.tmdb_id = pi.tmdb_id)
    OR (pi.tvdb_id IS NOT NULL AND ${r}.tvdb_id = pi.tvdb_id)
  )`;
}

/**
 * Attribution columns for the final SELECT. When unconfigured, these are
 * constant NULL/0 literals (no join, no query cost) so the row shape and
 * mapping logic below never need to branch per-row.
 *
 * Exported (only) so a test can pin the exact ISO-8601 `to_char(...)` format
 * emitted for `request_requested_at` (OMB-2 contract §7 - requestedAt is
 * documented as ISO-8601) without mocking the whole route + a live Postgres.
 */
export function buildRequestedBySelectFragment(configured: boolean): SQL {
  if (!configured) {
    return sql`
      NULL::uuid AS request_user_id,
      NULL::text AS request_username,
      NULL::text AS request_ombi_username,
      NULL::text AS request_ombi_alias,
      NULL::text AS request_requested_at,
      0::int AS request_distinct_requester_count,
    `;
  }
  return sql`
    rb.user_id AS request_user_id,
    rb.username AS request_username,
    rb.ombi_username AS request_ombi_username,
    rb.ombi_alias AS request_ombi_alias,
    -- ISO-8601 to match the frozen contract (StaleItemRequestedBy.requestedAt) -
    -- a bare text cast of the timestamp column alone emits Postgres' native
    -- "YYYY-MM-DD HH:MI:SS.US+00" format, not ISO-8601 (OMB-2). Mirrors
    -- routes/stats/requesters.ts.
    to_char(rb.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS request_requested_at,
    (
      SELECT COUNT(DISTINCT r2.ombi_user_id)::int
      FROM ombi_requests r2
      WHERE ${buildRequesterMatchCondition('r2')}
    ) AS request_distinct_requester_count,
  `;
}

/**
 * LEFT JOIN LATERAL picking the EARLIEST matching request (contract §7:
 * "earliest matching request wins"). Empty fragment when unconfigured - the
 * join is skipped entirely, not merely filtered.
 */
function buildRequestedByJoinFragment(configured: boolean): SQL {
  if (!configured) {
    return sql``;
  }
  return sql`
    LEFT JOIN LATERAL (
      SELECT r.user_id, u.username, r.ombi_username, r.ombi_alias, r.requested_at
      FROM ombi_requests r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE ${buildRequesterMatchCondition('r')}
      ORDER BY r.requested_at ASC
      LIMIT 1
    ) rb ON true
  `;
}

export const libraryStaleRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stale - Identify unwatched/stale content
   *
   * Returns library content that has never been watched or hasn't been
   * watched in the specified number of days (staleDays threshold).
   */
  app.get<{ Querystring: LibraryStaleQueryInput }>(
    '/stale',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStaleQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        mediaType,
        mediaTypes,
        staleDays,
        category,
        sortBy,
        sortOrder,
        page,
        pageSize,
      } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // mediaTypes (repeated param) takes precedence over the single mediaType when present.
      const mediaTypesSegment = mediaTypes
        ? mediaTypes.slice().sort().join(',')
        : (mediaType ?? 'all');

      // Build cache key with all varying params
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_STALE,
        serverCacheSegment,
        `${libraryId ?? 'all'}-${mediaTypesSegment}-${staleDays}-${category}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as StaleResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Ombi attribution (contract §7): single cheap settings check, then either a
      // real LEFT JOIN LATERAL + correlated subquery, or zero-cost NULL/0 literals.
      // This must not add query cost for the common case of no Ombi connector.
      const ombiSettings = await getSettings(['ombiUrl', 'ombiApiKey']);
      const ombiConfigured = Boolean(ombiSettings.ombiUrl && ombiSettings.ombiApiKey);
      const requestedBySelect = buildRequestedBySelectFragment(ombiConfigured);
      const requestedByJoin = buildRequestedByJoinFragment(ombiConfigured);

      // Build filters
      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      // mediaTypes (repeated param) takes precedence over the single mediaType; when
      // neither is provided, behavior is unchanged (no filter - all categories included).
      const mediaTypeFilter = mediaTypes
        ? sql`AND li.media_type IN (${sql.join(
            mediaTypes.map((mt) => sql`${mt}`),
            sql`, `
          )})`
        : mediaType
          ? sql`AND li.media_type = ${mediaType}`
          : sql``;

      // Category filter for final results
      const categoryFilter =
        category === 'never_watched'
          ? sql`AND category = 'never_watched'`
          : category === 'stale'
            ? sql`AND category = 'stale'`
            : sql``;

      // Sort column mapping - use sql.raw() for identifiers
      const sortColumnMap: Record<string, string> = {
        size: 'file_size',
        days_stale: 'days_stale',
        title: 'title',
        added_at: 'added_at',
      };
      const sortColumnName = sortColumnMap[sortBy] || 'file_size';
      const sortDirStr = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';
      const orderByClause = sql.raw(`${sortColumnName} ${sortDirStr}`);

      const offset = (page - 1) * pageSize;

      // Combined query: items with pagination AND summary statistics in one round-trip
      // Uses window functions for summary aggregation alongside item results
      const combinedResult = await db.execute(sql`
        WITH child_stats AS (
          -- Aggregate child data for shows (episodes) and artists (tracks)
          SELECT
            grandparent_rating_key,
            server_id,
            SUM(file_size) AS total_size,
            MAX(CASE video_resolution
              WHEN '4k' THEN 4
              WHEN '1080p' THEN 3
              WHEN '720p' THEN 2
              WHEN '480p' THEN 1
              ELSE 0
            END) AS best_resolution_tier
          FROM library_items
          WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        child_watch_stats AS (
          -- Get watch stats for shows/artists via their children
          SELECT
            child.grandparent_rating_key,
            child.server_id,
            MAX(sess.stopped_at) AS last_watched,
            COUNT(sess.id)::int AS watch_count
          FROM library_items child
          LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
            AND sess.server_id = child.server_id
            AND sess.duration_ms >= 120000
          WHERE child.media_type IN ('episode', 'track') AND child.grandparent_rating_key IS NOT NULL
          GROUP BY child.grandparent_rating_key, child.server_id
        ),
        item_watch_stats AS (
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.library_id,
            s.name AS library_name,
            li.title,
            li.media_type,
            li.year,
            -- Carried through to stale_items/paginated_items purely for the Ombi
            -- attribution join below (never returned to the client as columns).
            li.imdb_id,
            li.tmdb_id,
            li.tvdb_id,
            -- For shows/artists: use aggregated child size, otherwise use item's file_size
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size)
              ELSE li.file_size
            END AS file_size,
            -- For shows/artists: use best child resolution (mapped from numeric tier)
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(
                CASE cs.best_resolution_tier
                  WHEN 4 THEN '4k'
                  WHEN 3 THEN '1080p'
                  WHEN 2 THEN '720p'
                  WHEN 1 THEN '480p'
                  WHEN 0 THEN 'sd'
                END,
                li.video_resolution
              )
              ELSE li.video_resolution
            END AS video_resolution,
            li.created_at AS added_at,
            -- For shows/artists: use child watch stats
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN cws.last_watched
              ELSE MAX(sess.stopped_at)
            END AS last_watched,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cws.watch_count, 0)
              ELSE COUNT(sess.id)::int
            END AS watch_count
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          LEFT JOIN child_stats cs ON li.media_type IN ('show', 'artist')
            AND cs.grandparent_rating_key = li.rating_key
            AND cs.server_id = li.server_id
          LEFT JOIN child_watch_stats cws ON li.media_type IN ('show', 'artist')
            AND cws.grandparent_rating_key = li.rating_key
            AND cws.server_id = li.server_id
          LEFT JOIN sessions sess ON li.media_type NOT IN ('show', 'artist')
            AND sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
            AND sess.duration_ms >= 120000
          WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album')  -- Exclude children/containers, only show content
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
          GROUP BY li.id, li.server_id, s.name, li.library_id, li.title,
                   li.media_type, li.year, li.imdb_id, li.tmdb_id, li.tvdb_id,
                   li.file_size, li.video_resolution, li.created_at,
                   cs.total_size, cs.best_resolution_tier, cws.last_watched, cws.watch_count
        ),
        stale_items AS (
          SELECT
            id,
            server_id,
            server_name,
            library_id,
            library_name,
            title,
            media_type,
            year,
            imdb_id,
            tmdb_id,
            tvdb_id,
            file_size,
            video_resolution,
            added_at,
            last_watched,
            watch_count,
            CASE
              WHEN last_watched IS NULL THEN 'never_watched'
              ELSE 'stale'
            END AS category,
            CASE
              WHEN last_watched IS NULL THEN
                EXTRACT(DAY FROM NOW() - added_at)::int
              ELSE
                EXTRACT(DAY FROM NOW() - last_watched)::int
            END AS days_stale
          FROM item_watch_stats
          WHERE (
            last_watched IS NULL
            OR last_watched < NOW() - INTERVAL '1 day' * ${staleDays}
          )
        ),
        filtered_items AS (
          SELECT * FROM stale_items
          WHERE 1=1
            ${categoryFilter}
        ),
        -- Summary aggregation computed once over all filtered items
        summary_stats AS (
          SELECT
            COUNT(*) FILTER (WHERE category = 'never_watched') AS never_watched_count,
            COUNT(*) FILTER (WHERE category = 'stale') AS stale_count,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'never_watched'), 0) AS never_watched_bytes,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'stale'), 0) AS stale_bytes,
            COUNT(*) AS total_stale_items,
            COALESCE(SUM(file_size), 0) AS total_stale_bytes
          FROM filtered_items
        ),
        paginated_items AS (
          SELECT * FROM filtered_items
          ORDER BY ${orderByClause}
          LIMIT ${pageSize} OFFSET ${offset}
        )
        SELECT
          -- Item fields
          pi.id,
          pi.server_id,
          pi.server_name,
          pi.library_id,
          pi.library_name,
          pi.title,
          pi.media_type,
          pi.year,
          pi.file_size::text AS file_size,
          pi.video_resolution,
          pi.added_at::text AS added_at,
          pi.last_watched::text AS last_watched,
          pi.watch_count::text AS watch_count,
          pi.category,
          pi.days_stale::text AS days_stale,
          -- Ombi attribution (contract §7) - NULL/0 literals when unconfigured (see
          -- buildRequestedBySelectFragment), a real earliest-request join otherwise.
          ${requestedBySelect}
          -- Summary fields (same for all rows)
          ss.never_watched_count::text AS _never_watched_count,
          ss.stale_count::text AS _stale_count,
          ss.never_watched_bytes::text AS _never_watched_bytes,
          ss.stale_bytes::text AS _stale_bytes,
          ss.total_stale_items::text AS _total_stale_items,
          ss.total_stale_bytes::text AS _total_stale_bytes
        FROM paginated_items pi
        CROSS JOIN summary_stats ss
        ${requestedByJoin}
      `);

      // Extract items and summary from combined result
      interface CombinedRow extends RawStaleItemRow {
        _never_watched_count: string;
        _stale_count: string;
        _never_watched_bytes: string;
        _stale_bytes: string;
        _total_stale_items: string;
        _total_stale_bytes: string;
      }

      const rows = combinedResult.rows as unknown as CombinedRow[];

      const items: StaleItem[] = rows.map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        libraryId: row.library_id,
        libraryName: row.library_name,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
        resolution: row.video_resolution,
        addedAt: row.added_at,
        lastWatched: row.last_watched,
        watchCount: parseInt(row.watch_count, 10),
        category: row.category,
        daysStale: parseInt(row.days_stale, 10),
        requestedBy: row.request_ombi_username
          ? {
              userId: row.request_user_id,
              username: row.request_username,
              ombiUsername: row.request_ombi_username,
              ombiAlias: row.request_ombi_alias,
              requestedAt: row.request_requested_at!,
              otherRequesterCount: Math.max(0, (row.request_distinct_requester_count || 0) - 1),
              source: 'ombi' as const,
            }
          : null,
      }));

      // Extract summary from first row (or fetch separately if no items)
      let summary: StaleSummary;
      if (rows.length > 0) {
        const firstRow = rows[0]!;
        summary = {
          neverWatched: {
            count: parseInt(firstRow._never_watched_count, 10) || 0,
            sizeBytes: parseInt(firstRow._never_watched_bytes, 10) || 0,
          },
          stale: {
            count: parseInt(firstRow._stale_count, 10) || 0,
            sizeBytes: parseInt(firstRow._stale_bytes, 10) || 0,
          },
          total: {
            count: parseInt(firstRow._total_stale_items, 10) || 0,
            sizeBytes: parseInt(firstRow._total_stale_bytes, 10) || 0,
          },
          threshold: { days: staleDays },
        };
      } else {
        // No items on current page - need summary separately for empty page case
        const summaryResult = await db.execute(sql`
          WITH child_stats AS (
            SELECT grandparent_rating_key, server_id, SUM(file_size) AS total_size
            FROM library_items
            WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL
            GROUP BY grandparent_rating_key, server_id
          ),
          child_watch_stats AS (
            SELECT child.grandparent_rating_key, child.server_id, MAX(sess.stopped_at) AS last_watched
            FROM library_items child
            LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
              AND sess.server_id = child.server_id AND sess.duration_ms >= 120000
            WHERE child.media_type IN ('episode', 'track') AND child.grandparent_rating_key IS NOT NULL
            GROUP BY child.grandparent_rating_key, child.server_id
          ),
          item_watch_stats AS (
            SELECT li.id, li.server_id,
              CASE WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size) ELSE li.file_size END AS file_size,
              CASE WHEN li.media_type IN ('show', 'artist') THEN cws.last_watched ELSE MAX(sess.stopped_at) END AS last_watched
            FROM library_items li
            LEFT JOIN child_stats cs ON li.media_type IN ('show', 'artist') AND cs.grandparent_rating_key = li.rating_key AND cs.server_id = li.server_id
            LEFT JOIN child_watch_stats cws ON li.media_type IN ('show', 'artist') AND cws.grandparent_rating_key = li.rating_key AND cws.server_id = li.server_id
            LEFT JOIN sessions sess ON li.media_type NOT IN ('show', 'artist') AND sess.rating_key = li.rating_key AND sess.server_id = li.server_id AND sess.duration_ms >= 120000
            WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album') ${serverFilter} ${libraryFilter} ${mediaTypeFilter}
            GROUP BY li.id, li.server_id, li.media_type, li.file_size, cs.total_size, cws.last_watched
          ),
          stale_items AS (
            SELECT id, file_size, CASE WHEN last_watched IS NULL THEN 'never_watched' ELSE 'stale' END AS category
            FROM item_watch_stats WHERE (last_watched IS NULL OR last_watched < NOW() - INTERVAL '1 day' * ${staleDays})
          ),
          filtered AS (SELECT * FROM stale_items WHERE 1=1 ${categoryFilter})
          SELECT COUNT(*) FILTER (WHERE category = 'never_watched') AS never_watched_count,
            COUNT(*) FILTER (WHERE category = 'stale') AS stale_count,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'never_watched'), 0)::text AS never_watched_bytes,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'stale'), 0)::text AS stale_bytes,
            COUNT(*) AS total_stale_items, COALESCE(SUM(file_size), 0)::text AS total_stale_bytes
          FROM filtered
        `);
        const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
        summary = {
          neverWatched: {
            count: parseInt(summaryRow.never_watched_count, 10) || 0,
            sizeBytes: parseInt(summaryRow.never_watched_bytes, 10) || 0,
          },
          stale: {
            count: parseInt(summaryRow.stale_count, 10) || 0,
            sizeBytes: parseInt(summaryRow.stale_bytes, 10) || 0,
          },
          total: {
            count: parseInt(summaryRow.total_stale_items, 10) || 0,
            sizeBytes: parseInt(summaryRow.total_stale_bytes, 10) || 0,
          },
          threshold: { days: staleDays },
        };
      }

      // Get total count for pagination from summary
      const total = summary.total.count;

      const response: StaleResponse = {
        items,
        summary,
        pagination: { page, pageSize, total },
      };

      // Cache for 1 hour (stale content changes slowly).
      // SEAM: this cached payload now embeds Ombi requestedBy attribution
      // (contract §7). Invalidating REDIS_KEYS.LIBRARY_STALE on Ombi sync
      // completion and mapping changes is owned by the Ombi sync/mapping code
      // (services/ombi.ts, jobs/ombiSyncQueue.ts) - NOT implemented here.
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_STALE, JSON.stringify(response));

      return response;
    }
  );
};
