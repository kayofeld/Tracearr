/**
 * Library Top Content Routes
 *
 * GET /top-movies - Top movies by plays/watch time with time filtering
 * GET /top-shows - Top TV shows by engagement with binge scoring
 *
 * Features:
 * - Time period filtering (7d, 30d, 90d, 1y, all)
 * - Multi-server support with serverIds[] query param
 * - Deduplication across servers by external ID match key (movies) or normalized show title (shows)
 * - Per-item serverIds[] for frontend color dots
 * - Server-side sorting on all metrics
 * - Pagination support
 */

import {
  CACHE_TTL,
  REDIS_KEYS,
  topContentQuerySchema,
  type TopContentQueryInput,
  type TopMoviesResponse,
  type TopShowsResponse,
} from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Raw row from database for movies (multi-server dedup) */
interface RawMovieRow {
  match_key: string | null;
  media_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  server_ids: string[];
  total_plays: string;
  total_watch_hours: string;
  unique_viewers: string;
  completion_rate: string;
}

/** Raw row from database for shows (multi-server dedup) */
interface RawShowRow {
  show_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  server_ids: string[];
  total_episode_views: string;
  total_watch_hours: string;
  unique_viewers: string;
  avg_completion_rate: string;
  binge_score: string;
}

/** Convert period string to date range */
function getPeriodDates(period: string): { startDate: Date | null; endDate: Date } {
  const endDate = new Date();

  switch (period) {
    case '7d':
      return { startDate: new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000), endDate };
    case '30d':
      return { startDate: new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000), endDate };
    case '90d':
      return { startDate: new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000), endDate };
    case '1y':
      return { startDate: new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000), endDate };
    case 'all':
    default:
      return { startDate: null, endDate };
  }
}

/**
 * For 'all' period, find the earliest engagement data as the start date.
 * Falls back to 2020-01-01 if no data exists.
 */
async function resolveStartDate(startDate: Date | null): Promise<Date> {
  if (startDate) return startDate;

  const result = await db.execute(sql`
    SELECT MIN(day)::date AS earliest FROM daily_content_engagement
  `);
  const earliest = (result.rows[0] as { earliest: string | null })?.earliest;
  return earliest ? new Date(earliest) : new Date('2020-01-01');
}

export const libraryTopContentRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /top-movies - Top movies by engagement metrics
   *
   * Returns movies sorted by plays, watch hours, viewers, or completion rate.
   * Deduplicates across servers using external ID match key (imdb→tmdb→tvdb→title).
   * Each result includes serverIds[] for all servers that have/played this title.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-movies',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      // Empty resolved set means no accessible servers match the requested filter
      if (resolvedIds !== undefined && resolvedIds.length === 0) {
        const empty: TopMoviesResponse = {
          items: [],
          summary: { totalMovies: 0, totalWatchHours: 0 },
          pagination: { page, pageSize, total: 0 },
        };
        return empty;
      }

      const serverFilter = buildMultiServerFragment(resolvedIds, 'd.server_id');

      // Cache key includes resolved server IDs so multi/single server variants don't collide
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_MOVIES,
        serverCacheSegment,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopMoviesResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const effectiveStartDate = await resolveStartDate(startDate);
      const offset = (page - 1) * pageSize;

      // Movies don't have binge_score — fall back to total_plays
      const sortColumnMap: Record<string, string> = {
        plays: 'total_plays',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'completion_rate',
        binge_score: 'total_plays',
      };
      const sortColumn = sortColumnMap[sortBy] ?? 'total_plays';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      // Inline the get_content_engagement logic with multi-server filter + dedup.
      //
      // Dedup approach for movies:
      //   Join daily_content_engagement → library_items on (server_id, rating_key) to get
      //   external IDs (imdb_id, tmdb_id, tvdb_id) then build a COALESCE match key identical
      //   to buildExternalIdMatchKey. Rows that share a match key (same movie on multiple
      //   servers) are collapsed into one row; play counts and watch time are summed across
      //   all contributing servers.
      //
      // Per-item serverIds:
      //   ARRAY_AGG(DISTINCT d.server_id::text) collects every server that contributed plays
      //   to the deduped title. MIN(d.server_id::text) provides a stable primary for the
      //   legacy `serverId` / `serverName` scalar fields.
      const itemsResult = await db.execute(sql`
        WITH user_content AS (
          SELECT
            d.rating_key,
            d.server_user_id,
            MAX(d.media_title) AS media_title,
            MAX(d.content_duration_ms) AS content_duration_ms,
            MAX(d.thumb_path) AS thumb_path,
            MAX(d.server_id::text)::uuid AS server_id,
            MAX(d.year) AS year,
            SUM(d.watched_ms) AS watched_ms,
            MAX(d.max_progress_ms) AS max_progress_ms
          FROM daily_content_engagement d
          WHERE d.day >= ${effectiveStartDate}::timestamptz
            AND d.day < ${endDate}::timestamptz
            AND d.media_type = 'movie'
            ${serverFilter}
          GROUP BY d.rating_key, d.server_user_id
        ),
        content_agg AS (
          SELECT
            uc.rating_key,
            MAX(uc.media_title) AS media_title,
            MAX(uc.thumb_path) AS thumb_path,
            MAX(uc.server_id::text)::uuid AS server_id,
            MAX(uc.year) AS year,
            SUM(CASE
              WHEN uc.content_duration_ms > 0 THEN
                GREATEST(
                  CASE WHEN COALESCE(uc.max_progress_ms, 0) >= uc.content_duration_ms * 0.85 THEN 1
                       WHEN uc.watched_ms >= uc.content_duration_ms * 0.85 THEN 1
                       ELSE 0 END,
                  FLOOR(uc.watched_ms::float / uc.content_duration_ms)
                )
              ELSE 0
            END)::bigint AS total_plays,
            ROUND(SUM(uc.watched_ms) / 3600000.0, 1) AS total_watch_hours,
            COUNT(DISTINCT uc.server_user_id)::bigint AS unique_viewers,
            ROUND(100.0 * COUNT(DISTINCT uc.server_user_id) FILTER (
              WHERE uc.content_duration_ms > 0
                AND (COALESCE(uc.max_progress_ms, 0) >= uc.content_duration_ms * 0.85
                     OR uc.watched_ms >= uc.content_duration_ms * 0.85)
            ) / NULLIF(COUNT(DISTINCT uc.server_user_id), 0), 1) AS completion_rate
          FROM user_content uc
          GROUP BY uc.rating_key
        ),
        with_match_key AS (
          SELECT
            ca.*,
            COALESCE(
              CASE WHEN li.imdb_id IS NOT NULL AND li.imdb_id <> '' THEN 'imdb:' || li.imdb_id END,
              CASE WHEN li.tmdb_id IS NOT NULL THEN 'tmdb:' || li.tmdb_id::text END,
              CASE WHEN li.tvdb_id IS NOT NULL THEN 'tvdb:' || li.tvdb_id::text END,
              NULLIF('title:' || LOWER(REGEXP_REPLACE(COALESCE(ca.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), 'title:')
            ) AS match_key
          FROM content_agg ca
          LEFT JOIN library_items li
            ON li.server_id = ca.server_id
            AND li.rating_key = ca.rating_key
            AND li.media_type = 'movie'
        ),
        deduped AS (
          SELECT
            COALESCE(match_key, rating_key) AS dedup_key,
            MAX(media_title) AS media_title,
            MAX(year) AS year,
            MAX(thumb_path) AS thumb_path,
            MIN(server_id::text) AS server_id,
            ARRAY_AGG(DISTINCT server_id::text) AS server_ids,
            SUM(total_plays) AS total_plays,
            ROUND(SUM(total_watch_hours), 1) AS total_watch_hours,
            SUM(unique_viewers) AS unique_viewers,
            ROUND(AVG(completion_rate), 1) AS completion_rate
          FROM with_match_key
          WHERE media_title IS NOT NULL
          GROUP BY COALESCE(match_key, rating_key)
        )
        SELECT
          dedup_key AS match_key,
          media_title,
          year,
          thumb_path,
          server_id,
          server_ids,
          total_plays,
          total_watch_hours,
          unique_viewers,
          completion_rate
        FROM deduped
        ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const items = (itemsResult.rows as unknown as RawMovieRow[]).map((row) => ({
        ratingKey: row.match_key ?? '',
        title: row.media_title,
        year: row.year,
        thumbPath: row.thumb_path,
        serverId: row.server_id,
        serverIds: row.server_ids,
        totalPlays: parseInt(String(row.total_plays), 10) || 0,
        totalWatchHours: parseFloat(String(row.total_watch_hours)) || 0,
        uniqueViewers: parseInt(String(row.unique_viewers), 10) || 0,
        completionRate: parseFloat(String(row.completion_rate)) || 0,
      }));

      const summaryResult = await db.execute(sql`
        WITH user_content AS (
          SELECT
            d.rating_key,
            d.server_user_id,
            MAX(d.content_duration_ms) AS content_duration_ms,
            MAX(d.server_id::text)::uuid AS server_id,
            SUM(d.watched_ms) AS watched_ms,
            MAX(d.max_progress_ms) AS max_progress_ms
          FROM daily_content_engagement d
          WHERE d.day >= ${effectiveStartDate}::timestamptz
            AND d.day < ${endDate}::timestamptz
            AND d.media_type = 'movie'
            ${serverFilter}
          GROUP BY d.rating_key, d.server_user_id
        ),
        content_agg AS (
          SELECT
            uc.rating_key,
            MAX(uc.server_id::text)::uuid AS server_id,
            ROUND(SUM(uc.watched_ms) / 3600000.0, 1) AS total_watch_hours
          FROM user_content uc
          GROUP BY uc.rating_key
        ),
        with_match_key AS (
          SELECT
            ca.rating_key,
            ca.total_watch_hours,
            COALESCE(
              CASE WHEN li.imdb_id IS NOT NULL AND li.imdb_id <> '' THEN 'imdb:' || li.imdb_id END,
              CASE WHEN li.tmdb_id IS NOT NULL THEN 'tmdb:' || li.tmdb_id::text END,
              CASE WHEN li.tvdb_id IS NOT NULL THEN 'tvdb:' || li.tvdb_id::text END,
              NULLIF('title:' || LOWER(REGEXP_REPLACE(
                COALESCE((SELECT MAX(d2.media_title) FROM daily_content_engagement d2 WHERE d2.rating_key = ca.rating_key LIMIT 1), ''),
                '[^a-zA-Z0-9]', '', 'g')), 'title:')
            ) AS match_key
          FROM content_agg ca
          LEFT JOIN library_items li
            ON li.server_id = ca.server_id
            AND li.rating_key = ca.rating_key
            AND li.media_type = 'movie'
        ),
        deduped AS (
          SELECT
            COALESCE(match_key, rating_key) AS dedup_key,
            ROUND(SUM(total_watch_hours), 1) AS total_watch_hours
          FROM with_match_key
          GROUP BY COALESCE(match_key, rating_key)
        )
        SELECT
          COUNT(*) AS total_movies,
          COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
        FROM deduped
      `);

      const summaryRow = summaryResult.rows[0] as {
        total_movies: string;
        total_watch_hours: string;
      };
      const total = parseInt(String(summaryRow.total_movies), 10) || 0;

      const response: TopMoviesResponse = {
        items,
        summary: {
          totalMovies: total,
          totalWatchHours: parseFloat(String(summaryRow.total_watch_hours)) || 0,
        },
        pagination: { page, pageSize, total },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_MOVIES, JSON.stringify(response));

      return response;
    }
  );

  /**
   * GET /top-shows - Top TV shows by engagement metrics
   *
   * Returns TV shows sorted by episode views, watch hours, viewers, completion rate, or binge score.
   * Deduplicates across servers by normalized show title (lowercased, non-alphanumeric stripped).
   * Each result includes serverIds[] for all servers that have/played this show.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-shows',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      if (resolvedIds !== undefined && resolvedIds.length === 0) {
        const empty: TopShowsResponse = {
          items: [],
          summary: { totalShows: 0, totalWatchHours: 0 },
          pagination: { page, pageSize, total: 0 },
        };
        return empty;
      }

      const serverFilter = buildMultiServerFragment(resolvedIds, 'd.server_id');

      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_SHOWS,
        serverCacheSegment,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopShowsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const effectiveStartDate = await resolveStartDate(startDate);
      const offset = (page - 1) * pageSize;

      const sortColumnMap: Record<string, string> = {
        plays: 'total_episode_views',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'avg_completion_rate',
        binge_score: 'binge_score',
      };
      const sortColumn = sortColumnMap[sortBy] ?? 'total_episode_views';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      // Inline the get_show_engagement logic with multi-server filter + dedup.
      //
      // Dedup approach for shows:
      //   The daily_content_engagement view tracks episodes by (rating_key, server_user_id).
      //   The show identity lives in the show_title column (MAX(grandparent_title) from sessions).
      //   We normalize show_title — LOWER + strip non-alphanumeric — as the dedup key, which
      //   matches what buildExternalIdMatchKey uses for its title fallback. Shows that share the
      //   same normalized title across servers collapse into one row; episode views, watch hours
      //   and viewer counts are summed.
      //
      // Per-item serverIds:
      //   ARRAY_AGG(DISTINCT server_id::text) over the dedup group collects all contributing
      //   servers. MIN(server_id::text) gives a stable scalar for the legacy `serverId` field.
      const itemsResult = await db.execute(sql`
        WITH user_episodes AS (
          SELECT
            d.rating_key,
            d.server_user_id,
            MAX(d.show_title) AS show_title,
            MAX(d.content_duration_ms) AS content_duration_ms,
            MAX(d.thumb_path) AS thumb_path,
            MAX(d.server_id::text)::uuid AS server_id,
            MAX(d.year) AS year,
            SUM(d.watched_ms) AS watched_ms,
            MAX(d.max_progress_ms) AS max_progress_ms,
            COUNT(DISTINCT d.day) AS viewing_days
          FROM daily_content_engagement d
          WHERE d.day >= ${effectiveStartDate}::timestamptz
            AND d.day < ${endDate}::timestamptz
            AND d.show_title IS NOT NULL
            AND d.media_type = 'episode'
            ${serverFilter}
          GROUP BY d.rating_key, d.server_user_id
        ),
        user_shows AS (
          SELECT
            ue.server_user_id,
            ue.show_title,
            MAX(ue.thumb_path) AS thumb_path,
            MAX(ue.server_id::text)::uuid AS server_id,
            MAX(ue.year) AS year,
            COUNT(DISTINCT ue.rating_key) AS episodes_watched,
            SUM(ue.watched_ms) AS total_watched_ms,
            SUM(ue.viewing_days) AS total_viewing_days,
            COUNT(DISTINCT ue.rating_key) FILTER (
              WHERE ue.content_duration_ms > 0
                AND (COALESCE(ue.max_progress_ms, 0) >= ue.content_duration_ms * 0.85
                     OR ue.watched_ms >= ue.content_duration_ms * 0.85)
            ) AS completed_episodes
          FROM user_episodes ue
          GROUP BY ue.server_user_id, ue.show_title
        ),
        show_agg AS (
          SELECT
            us.show_title,
            MAX(us.server_id::text)::uuid AS server_id,
            MAX(us.thumb_path) AS thumb_path,
            MAX(us.year) AS year,
            SUM(us.episodes_watched)::bigint AS total_episode_views,
            ROUND(SUM(us.total_watched_ms) / 3600000.0, 1) AS total_watch_hours,
            COUNT(DISTINCT us.server_user_id)::bigint AS unique_viewers,
            ROUND(100.0 * SUM(us.completed_episodes) / NULLIF(SUM(us.episodes_watched), 0), 1) AS avg_completion_rate,
            LEAST(100, ROUND(
              40 * (AVG(us.episodes_watched)::numeric * ROUND(100.0 * SUM(us.completed_episodes) / NULLIF(SUM(us.episodes_watched), 0), 1) / 100 / 10) +
              30 * (SUM(us.total_viewing_days)::numeric / NULLIF(COUNT(DISTINCT us.server_user_id), 0) * 2) +
              30 * (SUM(us.completed_episodes)::numeric / NULLIF(SUM(us.episodes_watched), 0))
            , 0)) AS binge_score
          FROM user_shows us
          GROUP BY us.show_title
        ),
        deduped AS (
          SELECT
            LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g')) AS dedup_key,
            MAX(sa.show_title) AS show_title,
            MAX(sa.year) AS year,
            MAX(sa.thumb_path) AS thumb_path,
            MIN(sa.server_id::text) AS server_id,
            ARRAY_AGG(DISTINCT sa.server_id::text) AS server_ids,
            SUM(sa.total_episode_views)::bigint AS total_episode_views,
            ROUND(SUM(sa.total_watch_hours), 1) AS total_watch_hours,
            SUM(sa.unique_viewers)::bigint AS unique_viewers,
            ROUND(AVG(sa.avg_completion_rate), 1) AS avg_completion_rate,
            ROUND(AVG(sa.binge_score), 0) AS binge_score
          FROM show_agg sa
          WHERE sa.show_title IS NOT NULL
          GROUP BY LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g'))
        )
        SELECT
          show_title,
          year,
          thumb_path,
          server_id,
          server_ids,
          total_episode_views,
          total_watch_hours,
          unique_viewers,
          avg_completion_rate,
          binge_score
        FROM deduped
        ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const items = (itemsResult.rows as unknown as RawShowRow[]).map((row) => ({
        showTitle: row.show_title,
        year: row.year,
        thumbPath: row.thumb_path,
        serverId: row.server_id,
        serverIds: row.server_ids,
        totalEpisodeViews: parseInt(String(row.total_episode_views), 10) || 0,
        totalWatchHours: parseFloat(String(row.total_watch_hours)) || 0,
        uniqueViewers: parseInt(String(row.unique_viewers), 10) || 0,
        avgCompletionRate: parseFloat(String(row.avg_completion_rate)) || 0,
        bingeScore: parseFloat(String(row.binge_score)) || 0,
      }));

      const summaryResult = await db.execute(sql`
        WITH user_episodes AS (
          SELECT
            d.rating_key,
            d.server_user_id,
            MAX(d.show_title) AS show_title,
            MAX(d.content_duration_ms) AS content_duration_ms,
            MAX(d.server_id::text)::uuid AS server_id,
            SUM(d.watched_ms) AS watched_ms,
            MAX(d.max_progress_ms) AS max_progress_ms,
            COUNT(DISTINCT d.day) AS viewing_days
          FROM daily_content_engagement d
          WHERE d.day >= ${effectiveStartDate}::timestamptz
            AND d.day < ${endDate}::timestamptz
            AND d.show_title IS NOT NULL
            AND d.media_type = 'episode'
            ${serverFilter}
          GROUP BY d.rating_key, d.server_user_id
        ),
        user_shows AS (
          SELECT
            ue.server_user_id,
            ue.show_title,
            MAX(ue.server_id::text)::uuid AS server_id,
            SUM(ue.watched_ms) AS total_watched_ms,
            COUNT(DISTINCT ue.rating_key) AS episodes_watched,
            COUNT(DISTINCT ue.rating_key) FILTER (
              WHERE ue.content_duration_ms > 0
                AND (COALESCE(ue.max_progress_ms, 0) >= ue.content_duration_ms * 0.85
                     OR ue.watched_ms >= ue.content_duration_ms * 0.85)
            ) AS completed_episodes
          FROM user_episodes ue
          GROUP BY ue.server_user_id, ue.show_title
        ),
        show_agg AS (
          SELECT
            us.show_title,
            ROUND(SUM(us.total_watched_ms) / 3600000.0, 1) AS total_watch_hours
          FROM user_shows us
          GROUP BY us.show_title
        ),
        deduped AS (
          SELECT
            LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g')) AS dedup_key,
            ROUND(SUM(sa.total_watch_hours), 1) AS total_watch_hours
          FROM show_agg sa
          WHERE sa.show_title IS NOT NULL
          GROUP BY LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g'))
        )
        SELECT
          COUNT(*) AS total_shows,
          COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
        FROM deduped
      `);

      const summaryRow = summaryResult.rows[0] as {
        total_shows: string;
        total_watch_hours: string;
      };
      const total = parseInt(String(summaryRow.total_shows), 10) || 0;

      const response: TopShowsResponse = {
        items,
        summary: {
          totalShows: total,
          totalWatchHours: parseFloat(String(summaryRow.total_watch_hours)) || 0,
        },
        pagination: { page, pageSize, total },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_SHOWS, JSON.stringify(response));

      return response;
    }
  );
};
