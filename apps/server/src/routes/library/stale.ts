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
  type PlayedStateCoverage,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getSettings } from '../../services/settings.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { resolutionRankSql } from '../../utils/resolutionBuckets.js';
import { buildLibraryCacheKey } from './utils.js';
import { buildPlayedStateCoverage } from '../../services/playedStateSync.js';

/** Category for stale content */
type StaleCategory = 'never_watched' | 'stale';

/**
 * Requester attribution from a media request connector - Ombi and/or Seerr,
 * source-generalized by ADR 0006 (mirrors `@tracearr/shared`'s
 * `StaleItemRequestedBy` - contract §7; kept in sync by hand since this route
 * re-declares its response shapes locally rather than importing them). Null
 * when no connector is configured, the item matched no request, or the
 * request is unattributed to a Tracearr user (then ombiUsername still
 * identifies the raw requester). `ombiUsername`/`ombiAlias` keep their legacy
 * names but carry whichever source matched (contract §7 - renaming would
 * break the frozen wire shape).
 */
interface StaleItemRequestedBy {
  userId: string | null;
  username: string | null;
  ombiUsername: string;
  ombiAlias: string | null;
  requestedAt: string;
  otherRequesterCount: number;
  source: 'ombi' | 'seerr';
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
  /**
   * Per-server played-state coverage (ADR 0011). Optional per contract §7.3 -
   * mirrors NeverWatchedStatsResponse.playedStateCoverage; kept as a local
   * field here (not imported) because this file re-declares its response
   * shapes locally (see the file comment on StaleItemRequestedBy above).
   */
  playedStateCoverage?: PlayedStateCoverage;
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
  // Attribution columns - always present in the row shape (NULL/0 literals
  // when no connector is configured, so mapping logic never branches per-row).
  request_user_id: string | null;
  request_username: string | null;
  /** Raw source-side username (Ombi userName or Seerr's resolved display username). */
  request_source_username: string | null;
  /** Raw source-side alias/display name fallback. */
  request_source_alias: string | null;
  request_requested_at: string | null;
  /** Which connector matched ('ombi' | 'seerr'); null when no connector is configured. */
  request_source: 'ombi' | 'seerr' | null;
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
 * Match condition joining a stale item (under `itemAlias` - the row must carry
 * imdb_id/tmdb_id/tvdb_id/media_type; used for both the `paginated_items` CTE
 * and, for `requestedOnly` filtering, the pre-pagination `filtered_items`/`stale_items`
 * CTEs) to a `media_requests` row under `requestAlias`, scoped to the
 * currently-configured source set (design §4.4 - a disconnected source's rows
 * stay retained but invisible). Mirrors the /stats/requesters join and ADR
 * 0003: imdb -> tmdb -> tvdb precedence, no title fallback (wrong attribution
 * is worse than none). TV requests (`media_type = 'tv'`) match the SHOW item.
 */
function buildRequesterMatchCondition(
  itemAlias: string,
  requestAlias: string,
  sources: Array<'ombi' | 'seerr'>
): SQL {
  const item = sql.raw(itemAlias);
  const r = sql.raw(requestAlias);
  return sql`(
    (${item}.media_type = 'movie' AND ${r}.media_type = 'movie')
    OR (${item}.media_type = 'show' AND ${r}.media_type = 'tv')
  )
  AND ${r}.source IN (${sql.join(
    sources.map((s) => sql`${s}`),
    sql`, `
  )})
  AND (
    (${item}.imdb_id IS NOT NULL AND ${item}.imdb_id <> '' AND ${r}.imdb_id = ${item}.imdb_id)
    OR (${item}.tmdb_id IS NOT NULL AND ${item}.tmdb_id <> 0 AND ${r}.tmdb_id = ${item}.tmdb_id)
    OR (${item}.tvdb_id IS NOT NULL AND ${item}.tvdb_id <> 0 AND ${r}.tvdb_id = ${item}.tvdb_id)
  )`;
}

/**
 * Attribution columns for the final SELECT. When no connector is configured,
 * these are constant NULL/0 literals (no join, no query cost) so the row
 * shape and mapping logic below never need to branch per-row.
 *
 * `sources` defaults to both connectors so the exported single-argument call
 * shape used by tests keeps working; the route always passes the real
 * configured-source set explicitly.
 *
 * Exported (only) so a test can pin the exact ISO-8601 `to_char(...)` format
 * emitted for `request_requested_at` (OMB-2 contract §7 - requestedAt is
 * documented as ISO-8601) without mocking the whole route + a live Postgres.
 */
export function buildRequestedBySelectFragment(
  configured: boolean,
  sources: Array<'ombi' | 'seerr'> = ['ombi', 'seerr']
): SQL {
  if (!configured) {
    return sql`
      NULL::uuid AS request_user_id,
      NULL::text AS request_username,
      NULL::text AS request_source_username,
      NULL::text AS request_source_alias,
      NULL::text AS request_requested_at,
      NULL::text AS request_source,
      0::int AS request_distinct_requester_count,
    `;
  }
  return sql`
    rb.user_id AS request_user_id,
    rb.username AS request_username,
    rb.source_username AS request_source_username,
    rb.source_alias AS request_source_alias,
    -- ISO-8601 to match the frozen contract (StaleItemRequestedBy.requestedAt) -
    -- a bare text cast of the timestamp column alone emits Postgres' native
    -- "YYYY-MM-DD HH:MI:SS.US+00" format, not ISO-8601 (OMB-2). Mirrors
    -- routes/stats/requesters.ts.
    to_char(rb.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS request_requested_at,
    rb.source AS request_source,
    (
      -- Distinct requester identities across BOTH sources (design §4.4): a
      -- resolved user counts once even if they hold both an Ombi and a Seerr
      -- account; unresolved requesters never collide across sources.
      SELECT COUNT(DISTINCT COALESCE(r2.user_id::text, r2.source || ':' || r2.source_user_id))::int
      FROM media_requests r2
      WHERE ${buildRequesterMatchCondition('pi', 'r2', sources)}
    ) AS request_distinct_requester_count,
  `;
}

/**
 * LEFT JOIN LATERAL picking the EARLIEST matching request across every
 * currently-configured source (contract §7: "earliest matching request
 * wins", now spanning sources). Empty fragment when no connector is
 * configured - the join is skipped entirely, not merely filtered.
 */
function buildRequestedByJoinFragment(configured: boolean, sources: Array<'ombi' | 'seerr'>): SQL {
  if (!configured) {
    return sql``;
  }
  return sql`
    LEFT JOIN LATERAL (
      SELECT r.user_id, u.username, r.source_username, r.source_alias, r.requested_at, r.source
      FROM media_requests r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE ${buildRequesterMatchCondition('pi', 'r', sources)}
      ORDER BY r.requested_at ASC
      LIMIT 1
    ) rb ON true
  `;
}

/**
 * `requestedOnly` predicate: keeps only rows with AT LEAST ONE matching
 * request row, applied inside `filtered_items` (before the summary aggregation
 * and before pagination) so `pagination.total` and the returned page always
 * agree - the count query and the page query are literally the same CTE.
 *
 * Deliberately an existence check, not the earliest-request LATERAL join used
 * for display attribution: filtering only needs "does a match exist", so an
 * EXISTS (semi-join) is used here instead of duplicating the ORDER BY/LIMIT 1
 * lateral for every pre-pagination row. The earliest-request LATERAL join
 * still runs, unchanged, against the already-paginated page for the
 * `requestedBy` display fields.
 *
 * Returns an empty fragment when `requestedOnly` is false (today's default
 * query keeps its exact shape/cost) or when no connector is configured
 * (that case is short-circuited before this is ever called - see the route
 * handler - so this fragment is never actually reached unconfigured+true).
 */
export function buildRequestedOnlyFilterFragment(
  requestedOnly: boolean,
  configured: boolean,
  sources: Array<'ombi' | 'seerr'>,
  itemAlias: string
): SQL {
  if (!requestedOnly || !configured) {
    return sql``;
  }
  return sql`AND EXISTS (
    SELECT 1 FROM media_requests ro
    WHERE ${buildRequesterMatchCondition(itemAlias, 'ro', sources)}
  )`;
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
        requestedOnly,
      } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // mediaTypes (repeated param) takes precedence over the single mediaType when present.
      const mediaTypesSegment = mediaTypes
        ? mediaTypes.slice().sort().join(',')
        : (mediaType ?? 'all');

      // Build cache key with all varying params. requestedOnly must be part of
      // the key (not just the query) - otherwise a cached unfiltered response
      // would be served back for the filtered request and vice versa.
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_STALE,
        serverCacheSegment,
        `${libraryId ?? 'all'}-${mediaTypesSegment}-${staleDays}-${category}-${sortBy}-${sortOrder}-${page}-${pageSize}-${requestedOnly}`
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

      // Media request attribution (contract §7, generalized by design §4.4/§9):
      // single cheap settings check across both connectors, then either a real
      // LEFT JOIN LATERAL + correlated subquery scoped to the configured-source
      // set, or zero-cost NULL/0 literals. This must not add query cost for the
      // common case of no connector configured.
      const requestSettings = await getSettings([
        'ombiUrl',
        'ombiApiKey',
        'seerrUrl',
        'seerrApiKey',
      ]);
      const ombiConfigured = Boolean(requestSettings.ombiUrl && requestSettings.ombiApiKey);
      const seerrConfigured = Boolean(requestSettings.seerrUrl && requestSettings.seerrApiKey);
      const configuredSources: Array<'ombi' | 'seerr'> = [
        ...(ombiConfigured ? (['ombi'] as const) : []),
        ...(seerrConfigured ? (['seerr'] as const) : []),
      ];
      const anyConfigured = configuredSources.length > 0;
      const requestedBySelect = buildRequestedBySelectFragment(anyConfigured, configuredSources);
      const requestedByJoin = buildRequestedByJoinFragment(anyConfigured, configuredSources);

      // requestedOnly with no connector configured: there is nothing to match
      // against (the join fragment is skipped entirely), so an honest empty
      // result set is returned rather than silently ignoring the flag or
      // running a query that can never match. Short-circuits before touching
      // the DB - zero added query cost.
      if (requestedOnly && !anyConfigured) {
        const emptyResponse: StaleResponse = {
          items: [],
          summary: {
            neverWatched: { count: 0, sizeBytes: 0 },
            stale: { count: 0, sizeBytes: 0 },
            total: { count: 0, sizeBytes: 0 },
            threshold: { days: staleDays },
          },
          pagination: { page, pageSize, total: 0 },
          // Carried even on the empty short-circuit: this response is cached,
          // and omitting coverage would drop the banner and the copy swap on
          // this view alone while sibling views still show them.
          playedStateCoverage: await buildPlayedStateCoverage(resolvedIds),
        };
        await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_STALE, JSON.stringify(emptyResponse));
        return emptyResponse;
      }

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

      // requestedOnly filter (empty fragment - and thus zero added cost - unless
      // requestedOnly=true; the no-connector+requestedOnly case already
      // returned above). Applied inside filtered_items/filtered so the count
      // (summary_stats) and the page (paginated_items) read the exact same
      // filtered rows - see buildRequestedOnlyFilterFragment.
      const requestedOnlyFilter = buildRequestedOnlyFilterFragment(
        requestedOnly,
        anyConfigured,
        configuredSources,
        'si'
      );

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
        WITH watched_keys AS (
          -- Every library key any user has played, flattened to one column so
          -- the EXISTS below is a plain equality (design SS5.2, ADR 0010).
          -- A UNION rather than an OR across two columns: the OR form cannot
          -- drive a hash/merge join and measured 1417ms vs 15ms at production
          -- scale while using neither played_states index. Movie/episode ids
          -- live in rating_key and show ids only in series_rating_key, so the
          -- media_type guard the OR form needed is redundant here.
          SELECT server_id, rating_key AS key FROM played_states
          UNION
          SELECT server_id, series_rating_key FROM played_states
          WHERE series_rating_key IS NOT NULL
        ),
        top_items AS (
          -- Every top-level entry with its identity key. A title merged
          -- across libraries or servers has several entries sharing one
          -- ident; unmatched items fall back to their own id.
          SELECT li.id, li.server_id, li.library_id, li.rating_key, li.title,
                 li.media_type, li.year, li.video_resolution, li.created_at,
                 li.imdb_id, li.tmdb_id, li.tvdb_id,
                 COALESCE(li.media_id::text, li.id::text) AS ident
          FROM library_items li
          WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album')  -- Exclude children/containers, only show content
            AND li.removed_at IS NULL
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
        ),
        ident_sizes AS (
          -- Physical bytes per identity: the entries' own versions for
          -- movies, children's versions for shows/artists, mirror-deduped by
          -- (ident, byte size) - the same heuristic the storage totals use,
          -- so a merged entry listing the same file twice counts it once
          SELECT ident, SUM(sz) AS file_size
          FROM (
            SELECT DISTINCT b.ident, v.file_size AS sz
            FROM top_items b
            LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
              AND child.grandparent_rating_key = b.rating_key
              AND child.server_id = b.server_id
              AND child.removed_at IS NULL
            JOIN library_item_versions v
              ON v.library_item_id = COALESCE(child.id, b.id)
              AND v.removed_at IS NULL AND v.file_size IS NOT NULL
          ) d
          GROUP BY ident
        ),
        ident_watch AS (
          -- Watch state per identity: a play on ANY entry (or any entry's
          -- children) counts for the title
          SELECT b.ident,
                 MAX(sess.stopped_at) AS last_watched,
                 COUNT(DISTINCT COALESCE(sess.reference_id, sess.id))
                   FILTER (WHERE sess.id IS NOT NULL)::int AS watch_count
          FROM top_items b
          LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
            AND child.grandparent_rating_key = b.rating_key
            AND child.server_id = b.server_id
            AND child.removed_at IS NULL
          LEFT JOIN sessions sess ON sess.server_id = b.server_id
            AND sess.rating_key = COALESCE(child.rating_key, b.rating_key)
            AND sess.duration_ms >= 120000
          GROUP BY b.ident
        ),
        child_resolutions AS (
          SELECT grandparent_rating_key, server_id,
            (ARRAY_AGG(video_resolution ORDER BY ${resolutionRankSql('video_resolution')} DESC))[1]
              AS best_resolution
          FROM library_items
          WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL AND removed_at IS NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        ident_reps AS (
          -- One representative entry per identity for display fields
          SELECT DISTINCT ON (ident) ident, id, server_id, library_id, rating_key,
                 title, media_type, year, video_resolution, created_at,
                 imdb_id, tmdb_id, tvdb_id
          FROM top_items
          ORDER BY ident, created_at ASC NULLS LAST, id
        ),
        item_watch_stats AS (
          SELECT
            r.id,
            r.server_id,
            s.name AS server_name,
            r.library_id,
            s.name AS library_name,
            r.rating_key,
            r.title,
            r.media_type,
            r.year,
            r.imdb_id,
            r.tmdb_id,
            r.tvdb_id,
            isz.file_size,
            CASE
              WHEN r.media_type IN ('show', 'artist') THEN COALESCE(cr.best_resolution, r.video_resolution)
              ELSE r.video_resolution
            END AS video_resolution,
            r.created_at AS added_at,
            iw.last_watched,
            COALESCE(iw.watch_count, 0) AS watch_count
          FROM ident_reps r
          JOIN servers s ON r.server_id = s.id
          LEFT JOIN ident_sizes isz ON isz.ident = r.ident
          LEFT JOIN ident_watch iw ON iw.ident = r.ident
          LEFT JOIN child_resolutions cr ON r.media_type IN ('show', 'artist')
            AND cr.grandparent_rating_key = r.rating_key
            AND cr.server_id = r.server_id
        ),
        stale_items AS (
          SELECT
            id,
            server_id,
            server_name,
            library_id,
            library_name,
            rating_key,
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
          FROM item_watch_stats iws
          WHERE (
            last_watched IS NULL
            OR last_watched < NOW() - INTERVAL '1 day' * ${staleDays}
          )
          AND NOT (
            -- Played-state mirror (design §5.2, ADR 0010): an item with no
            -- qualifying session but a played flag from any user is provably
            -- watched (not never_watched) but undatable (not honestly
            -- stale - daysStale needs last_watched). It leaves this endpoint
            -- entirely rather than showing up in either category.
            last_watched IS NULL
            AND EXISTS (
              SELECT 1 FROM watched_keys w
              WHERE w.server_id = iws.server_id AND w.key = iws.rating_key
            )
          )
        ),
        filtered_items AS (
          SELECT * FROM stale_items si
          WHERE 1=1
            ${categoryFilter}
            ${requestedOnlyFilter}
        ),
        -- Summary aggregation computed once over all filtered items (this is
        -- also where requestedOnly is applied, so summary_stats/total and the
        -- paginated page below always agree - same filtered_items rows).
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
        requestedBy: row.request_source_username
          ? {
              userId: row.request_user_id,
              username: row.request_username,
              // Wire field keeps its legacy name (contract §7); carries
              // whichever source matched.
              ombiUsername: row.request_source_username,
              ombiAlias: row.request_source_alias,
              requestedAt: row.request_requested_at!,
              otherRequesterCount: Math.max(0, (row.request_distinct_requester_count || 0) - 1),
              // Populated from the row (design §9) rather than hardcoded, so a
              // Seerr match reports 'seerr'; falls back to 'ombi' only as a
              // defensive default (real rows always carry this column).
              source: row.request_source ?? 'ombi',
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
          WITH watched_keys AS (
            SELECT server_id, rating_key AS key FROM played_states
            UNION
            SELECT server_id, series_rating_key FROM played_states
            WHERE series_rating_key IS NOT NULL
          ),
          top_items AS (
            SELECT li.id, li.server_id, li.rating_key, li.media_type,
              li.imdb_id, li.tmdb_id, li.tvdb_id,
              COALESCE(li.media_id::text, li.id::text) AS ident
            FROM library_items li
            WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album') AND li.removed_at IS NULL ${serverFilter} ${libraryFilter} ${mediaTypeFilter}
          ),
          ident_sizes AS (
            SELECT ident, SUM(sz) AS file_size FROM (
              SELECT DISTINCT b.ident, v.file_size AS sz
              FROM top_items b
              LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
                AND child.grandparent_rating_key = b.rating_key AND child.server_id = b.server_id AND child.removed_at IS NULL
              JOIN library_item_versions v ON v.library_item_id = COALESCE(child.id, b.id)
                AND v.removed_at IS NULL AND v.file_size IS NOT NULL
            ) d GROUP BY ident
          ),
          ident_watch AS (
            SELECT b.ident, MAX(sess.stopped_at) AS last_watched,
              -- Same played-state rule as the paged query: a played flag with
              -- no session means watched-but-undatable, so the row leaves the
              -- endpoint rather than counting as never_watched here.
              BOOL_OR(EXISTS (
                SELECT 1 FROM watched_keys w
                WHERE w.server_id = b.server_id AND w.key = b.rating_key
              )) AS played_flagged
            FROM top_items b
            LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
              AND child.grandparent_rating_key = b.rating_key AND child.server_id = b.server_id AND child.removed_at IS NULL
            LEFT JOIN sessions sess ON sess.server_id = b.server_id
              AND sess.rating_key = COALESCE(child.rating_key, b.rating_key) AND sess.duration_ms >= 120000
            GROUP BY b.ident
          ),
          idents AS (
            SELECT DISTINCT ON (ident) ident, media_type, imdb_id, tmdb_id, tvdb_id
            FROM top_items ORDER BY ident, id
          ),
          stale_items AS (
            SELECT i.ident AS id, i.media_type, i.imdb_id, i.tmdb_id, i.tvdb_id, isz.file_size,
              CASE WHEN iw.last_watched IS NULL THEN 'never_watched' ELSE 'stale' END AS category
            FROM idents i
            LEFT JOIN ident_sizes isz ON isz.ident = i.ident
            LEFT JOIN ident_watch iw ON iw.ident = i.ident
            WHERE (iw.last_watched IS NULL OR iw.last_watched < NOW() - INTERVAL '1 day' * ${staleDays})
              AND NOT (iw.last_watched IS NULL AND COALESCE(iw.played_flagged, false))
          ),
          filtered AS (SELECT * FROM stale_items si WHERE 1=1 ${categoryFilter} ${requestedOnlyFilter})
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
        // Coverage (ADR 0011): scoped to the same resolvedIds as the query
        // above (§5.2/§7.3) so the banner names exactly the servers this
        // response covers.
        playedStateCoverage: await buildPlayedStateCoverage(resolvedIds),
      };

      // Cache for 1 hour (stale content changes slowly).
      // SEAM: this cached payload now embeds cross-source requestedBy
      // attribution (contract §7) AND played-state coverage (contract §7.3).
      // Invalidating REDIS_KEYS.LIBRARY_STALE on sync completion is owned by:
      // Ombi/Seerr mapping changes -> services/ombi.ts, jobs/ombiSyncQueue.ts
      // (+ Seerr equivalents); played-state sync completion ->
      // jobs/playedStateSyncQueue.ts's invalidatePlayedStateCaches - NOT
      // implemented here.
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_STALE, JSON.stringify(response));

      return response;
    }
  );
};
