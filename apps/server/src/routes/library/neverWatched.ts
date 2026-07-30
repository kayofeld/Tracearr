/**
 * Library Never-Watched Statistics Route
 *
 * GET /never-watched - Aggregate statistics over library items (movies + shows
 * only) that have never been played, for the "Never Watched" dashboard page.
 *
 * "Never watched" mirrors the definition used by GET /stale?category=never_watched:
 * no session with duration_ms >= 120000 joined on (server_id, rating_key). For
 * shows, this rolls up over child episodes via grandparent_rating_key - a show
 * counts as never-watched only if NO episode has a qualifying play.
 *
 * The paginated item list itself is served by GET /stale?category=never_watched;
 * this endpoint only returns the aggregate stats (totals, breakdowns, age
 * distribution) for the "Never Watched" dashboard page.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryNeverWatchedQuerySchema,
  type LibraryNeverWatchedQueryInput,
  type NeverWatchedAgeBucket,
  type NeverWatchedByLibrary,
  type NeverWatchedByMediaType,
  type NeverWatchedStatsResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';
import { buildPlayedStateCoverage } from '../../services/playedStateSync.js';

/** Age buckets, always returned in this order, zero-filled when empty. */
const AGE_BUCKETS: NeverWatchedAgeBucket[] = ['lt30', 'd30to90', 'd90to180', 'd180to365', 'gt365'];

/** Movie/show media types eligible for this endpoint's scope. */
const ELIGIBLE_MEDIA_TYPES: Array<'movie' | 'show'> = ['movie', 'show'];

/** Row shape for the combined stats query (JSON columns already parsed by pg). */
interface RawStatsRow {
  totals_count: number;
  totals_size_bytes: string;
  totals_library_count: number;
  totals_oldest_added_at: string | null;
  by_media_type: Array<{ mediaType: 'movie' | 'show'; count: number; sizeBytes: string }>;
  by_library: Array<{
    serverId: string;
    serverName: string;
    libraryId: string;
    libraryName: string;
    count: number;
    sizeBytes: string;
  }>;
  age_distribution: Array<{ bucket: NeverWatchedAgeBucket; count: number; sizeBytes: string }>;
}

/** Build the zero-valued response payload (used for empty server access). */
function buildEmptyResponse(
  mediaType: LibraryNeverWatchedQueryInput['mediaType']
): NeverWatchedStatsResponse {
  return {
    totals: { count: 0, sizeBytes: 0, libraryCount: 0, pctOfLibrary: 0 },
    byMediaType: eligibleMediaTypes(mediaType).map((type) => ({
      mediaType: type,
      count: 0,
      sizeBytes: 0,
    })),
    byLibrary: [],
    ageDistribution: AGE_BUCKETS.map((bucket) => ({ bucket, count: 0, sizeBytes: 0 })),
    oldestAddedAt: null,
  };
}

/** Media types in scope for the `byMediaType` zero-fill, per the mediaType filter. */
function eligibleMediaTypes(
  mediaType: LibraryNeverWatchedQueryInput['mediaType']
): Array<'movie' | 'show'> {
  if (mediaType === 'all') return ELIGIBLE_MEDIA_TYPES;
  return [mediaType];
}

export const libraryNeverWatchedRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /never-watched - Aggregate stats over never-watched movies + shows
   */
  app.get<{ Querystring: LibraryNeverWatchedQueryInput }>(
    '/never-watched',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryNeverWatchedQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds: rawServerIds, libraryId, mediaType } = query.data;
      const authUser = request.user;

      // resolveServerIds throws ForbiddenError (-> 403) for an unauthorized
      // explicit serverId, matching stale.ts's handling.
      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // Empty resolved server list (non-owner with no accessible servers) -
      // return a zero-valued payload without touching cache or the database.
      if (resolvedIds?.length === 0) {
        return buildEmptyResponse(mediaType);
      }

      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_NEVER_WATCHED,
        serverCacheSegment,
        `${libraryId ?? 'all'}-${mediaType}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as NeverWatchedStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter = mediaType === 'all' ? sql`` : sql`AND li.media_type = ${mediaType}`;

      const result = await db.execute(sql`
        WITH child_size AS (
          -- Aggregate episode file sizes per show, for size roll-up
          SELECT grandparent_rating_key, server_id, SUM(file_size) AS total_size
          FROM library_items
          WHERE media_type = 'episode' AND grandparent_rating_key IS NOT NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        scope_all AS (
          -- ALL movies + shows in scope (denominator for pctOfLibrary)
          SELECT li.id
          FROM library_items li
          WHERE li.media_type IN ('movie', 'show')
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
        ),
        never_watched_items AS (
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.library_id,
            -- Real display name from the libraries table (populated during
            -- librarySync). Falls back to the raw library_id when no row
            -- exists yet - either the table hasn't been backfilled by a sync
            -- since this feature shipped, or the library was just created and
            -- hasn't synced once.
            COALESCE(lib.name, li.library_id) AS library_name,
            li.media_type,
            li.created_at AS added_at,
            CASE
              WHEN li.media_type = 'show' THEN COALESCE(cs.total_size, li.file_size, 0)
              ELSE COALESCE(li.file_size, 0)
            END AS file_size
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          LEFT JOIN child_size cs ON li.media_type = 'show'
            AND cs.grandparent_rating_key = li.rating_key
            AND cs.server_id = li.server_id
          LEFT JOIN libraries lib ON lib.server_id = li.server_id
            AND lib.library_id = li.library_id
          WHERE li.media_type IN ('movie', 'show')
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
            AND NOT EXISTS (
              -- No qualifying session (>= 2 min) for this item, or (for shows)
              -- for any of its child episodes.
              SELECT 1 FROM sessions sess
              WHERE sess.duration_ms >= 120000
                AND sess.server_id = li.server_id
                AND (
                  (li.media_type = 'movie' AND sess.rating_key = li.rating_key)
                  OR (
                    li.media_type = 'show'
                    AND sess.rating_key IN (
                      SELECT child.rating_key FROM library_items child
                      WHERE child.media_type = 'episode'
                        AND child.grandparent_rating_key = li.rating_key
                        AND child.server_id = li.server_id
                    )
                  )
                )
            )
            AND NOT EXISTS (
              -- Played-state mirror (design §5.1, ADR 0010): any user's played
              -- flag on this item (movie) or the show itself via SeriesId
              -- (episode -> series_rating_key) counts as watched, even with no
              -- qualifying session (pre-polling history). No-op for Plex
              -- servers - they have zero played_states rows.
              SELECT 1 FROM played_states ps
              WHERE ps.server_id = li.server_id
                AND (
                  (li.media_type = 'movie' AND ps.rating_key = li.rating_key)
                  OR (li.media_type = 'show' AND ps.series_rating_key = li.rating_key)
                )
            )
        ),
        totals_data AS (
          SELECT
            COUNT(*)::int AS count,
            COALESCE(SUM(file_size), 0) AS size_bytes,
            (SELECT COUNT(*) FROM scope_all)::int AS library_count,
            MIN(added_at) AS oldest_added_at
          FROM never_watched_items
        ),
        by_media_type_data AS (
          SELECT media_type, COUNT(*)::int AS count, COALESCE(SUM(file_size), 0) AS size_bytes
          FROM never_watched_items
          GROUP BY media_type
        ),
        by_library_data AS (
          SELECT server_id, server_name, library_id, library_name,
            COUNT(*)::int AS count, COALESCE(SUM(file_size), 0) AS size_bytes
          FROM never_watched_items
          GROUP BY server_id, server_name, library_id, library_name
        ),
        age_distribution_data AS (
          SELECT
            CASE
              WHEN EXTRACT(DAY FROM NOW() - added_at) < 30 THEN 'lt30'
              WHEN EXTRACT(DAY FROM NOW() - added_at) < 90 THEN 'd30to90'
              WHEN EXTRACT(DAY FROM NOW() - added_at) < 180 THEN 'd90to180'
              WHEN EXTRACT(DAY FROM NOW() - added_at) < 365 THEN 'd180to365'
              ELSE 'gt365'
            END AS bucket,
            COUNT(*)::int AS count,
            COALESCE(SUM(file_size), 0) AS size_bytes
          FROM never_watched_items
          GROUP BY bucket
        )
        SELECT
          td.count AS totals_count,
          td.size_bytes::text AS totals_size_bytes,
          td.library_count AS totals_library_count,
          -- Strict ISO-8601 (with literal T/Z) - the pg default text cast
          -- ('2023-01-01 00:00:00+00') is rejected by Safari's Date parser.
          to_char(td.oldest_added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS totals_oldest_added_at,
          (SELECT COALESCE(json_agg(json_build_object(
              'mediaType', media_type,
              'count', count,
              'sizeBytes', size_bytes::text
            )), '[]') FROM by_media_type_data) AS by_media_type,
          (SELECT COALESCE(json_agg(json_build_object(
              'serverId', server_id,
              'serverName', server_name,
              'libraryId', library_id,
              'libraryName', library_name,
              'count', count,
              'sizeBytes', size_bytes::text
            )), '[]') FROM by_library_data) AS by_library,
          (SELECT COALESCE(json_agg(json_build_object(
              'bucket', bucket,
              'count', count,
              'sizeBytes', size_bytes::text
            )), '[]') FROM age_distribution_data) AS age_distribution
        FROM totals_data td
      `);

      const row = result.rows[0] as unknown as RawStatsRow | undefined;

      const response: NeverWatchedStatsResponse = row
        ? buildResponse(row, mediaType)
        : buildEmptyResponse(mediaType);

      // Coverage (ADR 0011): scoped to the same resolvedIds as the query
      // above, so the banner always names the servers this exact response
      // actually covers. Cached alongside the data - see §5.3.
      response.playedStateCoverage = await buildPlayedStateCoverage(resolvedIds);

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_NEVER_WATCHED, JSON.stringify(response));

      return response;
    }
  );
};

/** Transform the raw combined-query row into the response shape, zero-filling. */
function buildResponse(
  row: RawStatsRow,
  mediaType: LibraryNeverWatchedQueryInput['mediaType']
): NeverWatchedStatsResponse {
  const count = row.totals_count ?? 0;
  const libraryCount = row.totals_library_count ?? 0;
  const sizeBytes = parseInt(row.totals_size_bytes, 10) || 0;
  const pctOfLibrary = libraryCount === 0 ? 0 : Math.round((count / libraryCount) * 1000) / 10;

  const byMediaTypeMap = new Map<string, NeverWatchedByMediaType>();
  for (const entry of row.by_media_type ?? []) {
    byMediaTypeMap.set(entry.mediaType, {
      mediaType: entry.mediaType,
      count: entry.count,
      sizeBytes: parseInt(entry.sizeBytes, 10) || 0,
    });
  }
  const byMediaType: NeverWatchedByMediaType[] = eligibleMediaTypes(mediaType).map(
    (type) => byMediaTypeMap.get(type) ?? { mediaType: type, count: 0, sizeBytes: 0 }
  );

  const byLibrary: NeverWatchedByLibrary[] = (row.by_library ?? []).map((entry) => ({
    serverId: entry.serverId,
    serverName: entry.serverName,
    libraryId: entry.libraryId,
    libraryName: entry.libraryName,
    count: entry.count,
    sizeBytes: parseInt(entry.sizeBytes, 10) || 0,
  }));

  const ageDistributionMap = new Map<NeverWatchedAgeBucket, { count: number; sizeBytes: number }>();
  for (const entry of row.age_distribution ?? []) {
    ageDistributionMap.set(entry.bucket, {
      count: entry.count,
      sizeBytes: parseInt(entry.sizeBytes, 10) || 0,
    });
  }
  const ageDistribution = AGE_BUCKETS.map((bucket) => ({
    bucket,
    count: ageDistributionMap.get(bucket)?.count ?? 0,
    sizeBytes: ageDistributionMap.get(bucket)?.sizeBytes ?? 0,
  }));

  return {
    totals: { count, sizeBytes, libraryCount, pctOfLibrary },
    byMediaType,
    byLibrary,
    ageDistribution,
    oldestAddedAt: row.totals_oldest_added_at,
  };
}
