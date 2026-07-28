/**
 * Ombi Requester Statistics Route
 *
 * GET /requesters (mounted under /stats) - per-Tracearr-identity Ombi request
 * statistics, with a mandatory "unattributed" bucket for requests that could
 * not be resolved to a Tracearr user.
 *
 * Contract: docs/architecture/ombi-api-contract.md §6. ADR 0003 (query-time
 * external-id join to library_items, no FK, imdb -> tmdb -> tvdb precedence,
 * no title fallback for attribution).
 *
 * Request counts (requestCount/movieCount/tvCount/statusCounts) are
 * server-agnostic (Ombi is a single global instance). Fields derived from the
 * library-items/sessions join (matchedToLibraryCount, totalSizeBytes,
 * neverWatched*, watchedByRequesterCount) ARE scoped to the resolved servers.
 *
 * Aggregation is per Tracearr `users.id` identity (not per server_user),
 * consistent with user merges - see routes/stats/users.ts.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  requesterStatsQuerySchema,
  type RequesterStatsQueryInput,
  type RequesterStatsResponse,
  type RequesterStatsRow,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getSettings } from '../../services/settings.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from '../library/utils.js';

/** Sentinel identity key for unattributed requests (user_id IS NULL) in the grouped SQL. */
const UNATTRIBUTED_KEY = '__unattributed__';

/** Shared numeric/status fields present on both an attributed row and the unattributed bucket. */
interface RawStatsFields {
  requestCount: number;
  movieCount: number;
  tvCount: number;
  statusCounts: { pending: number; approved: number; denied: number; available: number };
  matchedToLibraryCount: number;
  totalSizeBytes: string;
  neverWatchedCount: number;
  neverWatchedSizeBytes: string;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

interface RawIdentityRow extends RawStatsFields {
  userId: string;
  username: string | null;
  watchedByRequesterCount: number;
}

/** Raw shape of the single-row combined query result. */
interface RawQueryRow {
  requesters: RawIdentityRow[] | null;
  unattributed_raw: RawStatsFields | null;
  requester_count: number | null;
  total_request_count: number | null;
  total_never_watched_size_bytes: string | null;
}

/** Build a response row from raw SQL fields, filling in identity + watched count. */
function buildRow(
  userId: string | null,
  username: string | null,
  watchedByRequesterCount: number,
  raw: RawStatsFields
): RequesterStatsRow {
  return {
    userId,
    username,
    requestCount: raw.requestCount,
    movieCount: raw.movieCount,
    tvCount: raw.tvCount,
    statusCounts: raw.statusCounts,
    matchedToLibraryCount: raw.matchedToLibraryCount,
    totalSizeBytes: parseInt(raw.totalSizeBytes, 10) || 0,
    neverWatchedCount: raw.neverWatchedCount,
    neverWatchedSizeBytes: parseInt(raw.neverWatchedSizeBytes, 10) || 0,
    watchedByRequesterCount,
    firstRequestAt: raw.firstRequestAt,
    lastRequestAt: raw.lastRequestAt,
  };
}

/** Zero-valued row - used for the unattributed bucket when empty, and for unconfigured/no-access responses. */
function zeroRow(): RequesterStatsRow {
  return {
    userId: null,
    username: null,
    requestCount: 0,
    movieCount: 0,
    tvCount: 0,
    statusCounts: { pending: 0, approved: 0, denied: 0, available: 0 },
    matchedToLibraryCount: 0,
    totalSizeBytes: 0,
    neverWatchedCount: 0,
    neverWatchedSizeBytes: 0,
    watchedByRequesterCount: 0,
    firstRequestAt: null,
    lastRequestAt: null,
  };
}

/** Empty/zeroed payload - unconfigured connector or no accessible servers. */
function emptyResponse(configured: boolean): RequesterStatsResponse {
  return {
    requesters: [],
    unattributed: zeroRow(),
    totals: { requestCount: 0, requesterCount: 0, unattributedCount: 0, neverWatchedSizeBytes: 0 },
    configured,
    generatedAt: new Date().toISOString(),
  };
}

export const requesterStatsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /requesters - per-requester Ombi statistics + unattributed bucket
   */
  app.get<{ Querystring: RequesterStatsQueryInput }>(
    '/requesters',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = requesterStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds: rawServerIds, mediaType } = query.data;
      const authUser = request.user;

      // Cheap settings check first - unconfigured is a true no-op (no DB work).
      const settingsConfig = await getSettings(['ombiUrl', 'ombiApiKey']);
      const configured = Boolean(settingsConfig.ombiUrl && settingsConfig.ombiApiKey);
      if (!configured) {
        return emptyResponse(false);
      }

      // resolveServerIds throws ForbiddenError (-> 403) for an unauthorized
      // explicit serverId, matching the other stats/library routes.
      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // Empty resolved server list (non-owner with no accessible servers) -
      // request counts would still be server-agnostic, but with zero server
      // access there is nothing this caller may see; keep it simple and
      // return the zeroed shape without touching cache or the database.
      if (resolvedIds?.length === 0) {
        return emptyResponse(true);
      }

      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.OMBI_REQUESTER_STATS,
        serverCacheSegment,
        mediaType
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as RequesterStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const mediaTypeFilter = mediaType === 'all' ? sql`` : sql`AND r.media_type = ${mediaType}`;

      const result = await db.execute(sql`
        WITH filtered_requests AS (
          SELECT
            r.id,
            r.user_id,
            r.media_type,
            r.status,
            r.requested_at,
            r.imdb_id,
            r.tmdb_id,
            r.tvdb_id
          FROM ombi_requests r
          WHERE true ${mediaTypeFilter}
        ),
        -- Query-time external-id join to library_items (ADR 0003): imdb -> tmdb ->
        -- tvdb precedence, LATERAL pick-first for determinism, NO title fallback
        -- (wrong attribution is worse than none - ADR 0003). TV requests match the
        -- SHOW item; movie requests match the movie item. Scoped to resolvedIds so
        -- watch/size-derived fields vary with the server filter while request
        -- counts (computed straight off filtered_requests, not this CTE) do not.
        matched AS (
          SELECT
            r.id AS request_id,
            r.user_id,
            r.media_type,
            r.status,
            r.requested_at,
            m.item_id,
            m.item_server_id,
            m.item_rating_key,
            m.item_media_type
          FROM filtered_requests r
          LEFT JOIN LATERAL (
            SELECT li.id AS item_id, li.server_id AS item_server_id,
                   li.rating_key AS item_rating_key, li.media_type AS item_media_type
            FROM library_items li
            WHERE (
              (r.media_type = 'movie' AND li.media_type = 'movie')
              OR (r.media_type = 'tv' AND li.media_type = 'show')
            )
            ${serverFilter}
            AND (
              (r.imdb_id IS NOT NULL AND r.imdb_id <> '' AND li.imdb_id = r.imdb_id)
              OR (r.tmdb_id IS NOT NULL AND li.tmdb_id = r.tmdb_id)
              OR (r.tvdb_id IS NOT NULL AND li.tvdb_id = r.tvdb_id)
            )
            ORDER BY
              CASE
                WHEN r.imdb_id IS NOT NULL AND r.imdb_id <> '' AND li.imdb_id = r.imdb_id THEN 0
                WHEN r.tmdb_id IS NOT NULL AND li.tmdb_id = r.tmdb_id THEN 1
                WHEN r.tvdb_id IS NOT NULL AND li.tvdb_id = r.tvdb_id THEN 2
                ELSE 3
              END,
              li.id
            LIMIT 1
          ) m ON true
        ),
        -- Per-identity request-row counts. Grouped on user_id (COALESCEd to a
        -- sentinel for the mandatory unattributed bucket) - these counts are
        -- computed directly off request rows, so they never vary with the
        -- server filter (Ombi is global).
        request_agg AS (
          SELECT
            COALESCE(user_id::text, ${UNATTRIBUTED_KEY}) AS identity_key,
            user_id,
            COUNT(*)::int AS request_count,
            COUNT(*) FILTER (WHERE media_type = 'movie')::int AS movie_count,
            COUNT(*) FILTER (WHERE media_type = 'tv')::int AS tv_count,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
            COUNT(*) FILTER (WHERE status = 'denied')::int AS denied_count,
            COUNT(*) FILTER (WHERE status = 'available')::int AS available_count,
            COUNT(*) FILTER (WHERE item_id IS NOT NULL)::int AS matched_to_library_count,
            MIN(requested_at) AS first_request_at,
            MAX(requested_at) AS last_request_at
          FROM matched
          GROUP BY identity_key, user_id
        ),
        -- Distinct matched media items, deduped globally by item (not by
        -- requester) so a show requested via several season-batch child rows -
        -- by the same or different requesters - is not double-counted in size
        -- or never-watched totals.
        distinct_items_global AS (
          SELECT DISTINCT item_id, item_server_id, item_rating_key, item_media_type
          FROM matched
          WHERE item_id IS NOT NULL
        ),
        -- Episode roll-up for shows (mirrors routes/library/stale.ts's child_stats).
        child_stats AS (
          SELECT grandparent_rating_key, server_id, SUM(file_size) AS total_size
          FROM library_items
          WHERE media_type = 'episode' AND grandparent_rating_key IS NOT NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        -- Episode watch-count roll-up for shows (mirrors stale.ts's child_watch_stats;
        -- same qualifying-play rule: duration_ms >= 120000).
        child_watch_stats AS (
          SELECT child.grandparent_rating_key, child.server_id, COUNT(sess.id)::int AS watch_count
          FROM library_items child
          LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
            AND sess.server_id = child.server_id
            AND sess.duration_ms >= 120000
          WHERE child.media_type = 'episode' AND child.grandparent_rating_key IS NOT NULL
          GROUP BY child.grandparent_rating_key, child.server_id
        ),
        -- Size + "watched by anyone" per distinct matched item (movies: own
        -- file_size/sessions; shows: episode roll-up).
        item_stats AS (
          SELECT
            dig.item_id,
            CASE
              WHEN dig.item_media_type = 'show' THEN COALESCE(cs.total_size, li.file_size, 0)
              ELSE COALESCE(li.file_size, 0)
            END AS file_size,
            CASE
              WHEN dig.item_media_type = 'show' THEN COALESCE(cws.watch_count, 0)
              ELSE COUNT(sess.id)
            END AS watch_count
          FROM distinct_items_global dig
          JOIN library_items li ON li.id = dig.item_id
          LEFT JOIN child_stats cs ON dig.item_media_type = 'show'
            AND cs.grandparent_rating_key = dig.item_rating_key
            AND cs.server_id = dig.item_server_id
          LEFT JOIN child_watch_stats cws ON dig.item_media_type = 'show'
            AND cws.grandparent_rating_key = dig.item_rating_key
            AND cws.server_id = dig.item_server_id
          LEFT JOIN sessions sess ON dig.item_media_type <> 'show'
            AND sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
            AND sess.duration_ms >= 120000
          GROUP BY dig.item_id, dig.item_media_type, li.file_size, cs.total_size, cws.watch_count
        ),
        -- (identity, item) pairs - a requester's own set of distinct matched items.
        item_identity_map AS (
          SELECT DISTINCT COALESCE(user_id::text, ${UNATTRIBUTED_KEY}) AS identity_key, item_id
          FROM matched
          WHERE item_id IS NOT NULL
        ),
        item_agg AS (
          SELECT
            iim.identity_key,
            COALESCE(SUM(ist.file_size), 0)::bigint AS total_size_bytes,
            COUNT(*) FILTER (WHERE ist.watch_count = 0)::int AS never_watched_count,
            COALESCE(SUM(ist.file_size) FILTER (WHERE ist.watch_count = 0), 0)::bigint AS never_watched_size_bytes
          FROM item_identity_map iim
          JOIN item_stats ist ON ist.item_id = iim.item_id
          GROUP BY iim.identity_key
        ),
        -- Global (non-per-identity) never-watched size total, for the response's
        -- top-level totals.neverWatchedSizeBytes ("across everyone") - dedupes a
        -- co-requested item instead of summing it once per requester.
        totals_agg AS (
          SELECT COALESCE(SUM(file_size) FILTER (WHERE watch_count = 0), 0)::bigint AS total_never_watched_size_bytes
          FROM item_stats
        ),
        -- Global "who has a qualifying play of this movie" - joined against the
        -- requester's own server_users rows below. sessions has no
        -- grandparent_rating_key column, so shows roll up via their episodes,
        -- same as child_watch_stats above.
        user_movie_watch AS (
          SELECT DISTINCT li.rating_key, li.server_id, su.user_id
          FROM library_items li
          JOIN sessions sess ON sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
            AND sess.duration_ms >= 120000
          JOIN server_users su ON su.id = sess.server_user_id
          WHERE li.media_type NOT IN ('show', 'episode', 'season', 'artist', 'album', 'track')
        ),
        user_child_watch AS (
          SELECT DISTINCT child.grandparent_rating_key, child.server_id, su.user_id
          FROM library_items child
          JOIN sessions sess ON sess.rating_key = child.rating_key
            AND sess.server_id = child.server_id
            AND sess.duration_ms >= 120000
          JOIN server_users su ON su.id = sess.server_user_id
          WHERE child.media_type = 'episode' AND child.grandparent_rating_key IS NOT NULL
        ),
        -- watchedByRequesterCount: matched items with a qualifying play by THIS
        -- identity's own server_users rows. Always empty for the unattributed
        -- bucket (excluded below), per contract.
        identity_watch AS (
          SELECT DISTINCT iim.identity_key, iim.item_id
          FROM item_identity_map iim
          JOIN distinct_items_global dig ON dig.item_id = iim.item_id
          WHERE iim.identity_key <> ${UNATTRIBUTED_KEY}
            AND (
              (dig.item_media_type <> 'show' AND EXISTS (
                SELECT 1 FROM user_movie_watch umw
                WHERE umw.rating_key = dig.item_rating_key
                  AND umw.server_id = dig.item_server_id
                  AND umw.user_id::text = iim.identity_key
              ))
              OR (dig.item_media_type = 'show' AND EXISTS (
                SELECT 1 FROM user_child_watch ucw
                WHERE ucw.grandparent_rating_key = dig.item_rating_key
                  AND ucw.server_id = dig.item_server_id
                  AND ucw.user_id::text = iim.identity_key
              ))
            )
        ),
        watched_agg AS (
          SELECT identity_key, COUNT(*)::int AS watched_by_requester_count
          FROM identity_watch
          GROUP BY identity_key
        ),
        final AS (
          SELECT
            ra.identity_key,
            ra.user_id,
            u.username,
            ra.request_count,
            ra.movie_count,
            ra.tv_count,
            ra.pending_count,
            ra.approved_count,
            ra.denied_count,
            ra.available_count,
            ra.matched_to_library_count,
            ra.first_request_at,
            ra.last_request_at,
            COALESCE(ia.total_size_bytes, 0) AS total_size_bytes,
            COALESCE(ia.never_watched_count, 0) AS never_watched_count,
            COALESCE(ia.never_watched_size_bytes, 0) AS never_watched_size_bytes,
            COALESCE(wa.watched_by_requester_count, 0) AS watched_by_requester_count
          FROM request_agg ra
          LEFT JOIN users u ON u.id = ra.user_id
          LEFT JOIN item_agg ia ON ia.identity_key = ra.identity_key
          LEFT JOIN watched_agg wa ON wa.identity_key = ra.identity_key
        )
        SELECT
          (SELECT COALESCE(json_agg(json_build_object(
              'userId', user_id,
              'username', username,
              'requestCount', request_count,
              'movieCount', movie_count,
              'tvCount', tv_count,
              'statusCounts', json_build_object(
                'pending', pending_count,
                'approved', approved_count,
                'denied', denied_count,
                'available', available_count
              ),
              'matchedToLibraryCount', matched_to_library_count,
              'totalSizeBytes', total_size_bytes::text,
              'neverWatchedCount', never_watched_count,
              'neverWatchedSizeBytes', never_watched_size_bytes::text,
              'watchedByRequesterCount', watched_by_requester_count,
              'firstRequestAt', to_char(first_request_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'lastRequestAt', to_char(last_request_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ) ORDER BY request_count DESC), '[]')
           FROM final WHERE identity_key <> ${UNATTRIBUTED_KEY}) AS requesters,
          (SELECT json_build_object(
              'requestCount', request_count,
              'movieCount', movie_count,
              'tvCount', tv_count,
              'statusCounts', json_build_object(
                'pending', pending_count,
                'approved', approved_count,
                'denied', denied_count,
                'available', available_count
              ),
              'matchedToLibraryCount', matched_to_library_count,
              'totalSizeBytes', total_size_bytes::text,
              'neverWatchedCount', never_watched_count,
              'neverWatchedSizeBytes', never_watched_size_bytes::text,
              'firstRequestAt', to_char(first_request_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'lastRequestAt', to_char(last_request_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
           FROM final WHERE identity_key = ${UNATTRIBUTED_KEY}) AS unattributed_raw,
          (SELECT COUNT(*)::int FROM final WHERE identity_key <> ${UNATTRIBUTED_KEY}) AS requester_count,
          (SELECT COALESCE(SUM(request_count), 0)::int FROM final) AS total_request_count,
          (SELECT total_never_watched_size_bytes::text FROM totals_agg) AS total_never_watched_size_bytes
      `);

      const row = result.rows[0] as unknown as RawQueryRow | undefined;

      const requesters: RequesterStatsRow[] = (row?.requesters ?? []).map((r) =>
        buildRow(r.userId, r.username, r.watchedByRequesterCount, r)
      );

      const unattributed: RequesterStatsRow = row?.unattributed_raw
        ? buildRow(null, null, 0, row.unattributed_raw)
        : zeroRow();

      const response: RequesterStatsResponse = {
        requesters,
        unattributed,
        totals: {
          requestCount: row?.total_request_count ?? 0,
          requesterCount: row?.requester_count ?? 0,
          unattributedCount: unattributed.requestCount,
          neverWatchedSizeBytes: parseInt(row?.total_never_watched_size_bytes ?? '0', 10) || 0,
        },
        configured: true,
        generatedAt: new Date().toISOString(),
      };

      await app.redis.setex(cacheKey, CACHE_TTL.OMBI_REQUESTER_STATS, JSON.stringify(response));

      return response;
    }
  );
};
