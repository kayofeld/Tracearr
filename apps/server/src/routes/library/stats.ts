/**
 * Library Stats Route
 *
 * GET /stats - Current library statistics from library_items
 *
 * Inventory KPIs (totalItems, movieCount, showCount, episodeCount, itemsAdded) are
 * COUNT(DISTINCT matchKey) — the COALESCE(imdb→tmdb→tvdb→title) key — so the same
 * title on two servers counts once, not twice.
 *
 * Total storage is a plain SUM(file_size) because bytes on disk are physical: the
 * same film stored on two servers occupies two files.
 *
 * byServer contains per-server raw counts (not deduped) so the frontend can display
 * server-level breakdowns without a second request.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStatsQuerySchema,
  type LibraryStatsQueryInput,
  type LibraryStatsServerKpis,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryItems } from '../../db/schema.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildExternalIdMatchKey } from '../../services/library/buildExternalIdMatchKey.js';
import { buildLibraryCacheKey } from './utils.js';

/** Library stats response shape */
interface LibraryStatsResponse {
  totalItems: number;
  totalSizeBytes: string;
  movieCount: number;
  episodeCount: number;
  showCount: number;
  qualityBreakdown: {
    count4k: number;
    count1080p: number;
    count720p: number;
    countSd: number;
  };
  asOf: string | null;
  byServer?: Record<string, LibraryStatsServerKpis>;
}

export const libraryStatsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stats - Current library statistics
   *
   * Returns aggregated library statistics deduped by external ID match key.
   * Supports filtering by serverId / serverIds and libraryId.
   */
  app.get<{ Querystring: LibraryStatsQueryInput }>(
    '/stats',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, libraryId, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

      // Build cache key — include sorted server IDs so order doesn't cause misses
      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_STATS, serverCacheKey, tz);
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const matchKey = buildExternalIdMatchKey(libraryItems);

      // Deduped inventory counts via COUNT(DISTINCT matchKey).
      // Items with no external ID fall back to a normalised title key so they still
      // dedupe across servers when the title is identical.
      // Storage is SUM — physical bytes are never deduped.
      const result = await db.execute(sql`
        SELECT
          COUNT(DISTINCT CASE WHEN li.file_size > 0 OR li.media_type IN ('show', 'season') THEN ${matchKey} END)::int AS total_items,
          COALESCE(SUM(COALESCE(li.file_size, 0)), 0)::bigint AS total_size_bytes,
          COUNT(DISTINCT CASE WHEN li.media_type = 'movie' THEN ${matchKey} END)::int AS movie_count,
          COUNT(DISTINCT CASE WHEN li.media_type = 'episode' THEN ${matchKey} END)::int AS episode_count,
          COUNT(DISTINCT CASE WHEN li.media_type = 'show' THEN ${matchKey} END)::int AS show_count,
          COUNT(CASE WHEN li.video_resolution = '4k' THEN 1 END)::int AS count_4k,
          COUNT(CASE WHEN li.video_resolution = '1080p' THEN 1 END)::int AS count_1080p,
          COUNT(CASE WHEN li.video_resolution = '720p' THEN 1 END)::int AS count_720p,
          COUNT(CASE WHEN li.video_resolution = 'sd' THEN 1 END)::int AS count_sd,
          MAX(li.updated_at)::text AS as_of
        FROM library_items li
        WHERE 1=1
          ${serverFilter}
          ${libraryFilter}
      `);

      const row = result.rows[0] as
        | {
            total_items: number;
            total_size_bytes: string;
            movie_count: number;
            episode_count: number;
            show_count: number;
            count_4k: number;
            count_1080p: number;
            count_720p: number;
            count_sd: number;
            as_of: string | null;
          }
        | undefined;

      // Per-server raw (non-deduped) counts so the frontend can show server breakdowns.
      // Storage stays as SUM per server — still physical.
      const perServerResult = await db.execute(sql`
        SELECT
          li.server_id,
          COUNT(DISTINCT CASE WHEN li.file_size > 0 OR li.media_type IN ('show', 'season') THEN ${matchKey} END)::int AS total_items,
          COALESCE(SUM(COALESCE(li.file_size, 0)), 0)::bigint AS total_size_bytes,
          COUNT(DISTINCT CASE WHEN li.media_type = 'movie' THEN ${matchKey} END)::int AS movie_count,
          COUNT(DISTINCT CASE WHEN li.media_type = 'episode' THEN ${matchKey} END)::int AS episode_count,
          COUNT(DISTINCT CASE WHEN li.media_type = 'show' THEN ${matchKey} END)::int AS show_count
        FROM library_items li
        WHERE 1=1
          ${serverFilter}
          ${libraryFilter}
        GROUP BY li.server_id
      `);

      const byServer: Record<string, LibraryStatsServerKpis> = {};
      for (const r of perServerResult.rows as {
        server_id: string;
        total_items: number;
        total_size_bytes: string;
        movie_count: number;
        episode_count: number;
        show_count: number;
      }[]) {
        byServer[r.server_id] = {
          totalItems: r.total_items,
          totalSizeBytes: r.total_size_bytes,
          movieCount: r.movie_count,
          episodeCount: r.episode_count,
          showCount: r.show_count,
        };
      }

      const stats: LibraryStatsResponse = {
        totalItems: row?.total_items ?? 0,
        totalSizeBytes: row?.total_size_bytes ?? '0',
        movieCount: row?.movie_count ?? 0,
        episodeCount: row?.episode_count ?? 0,
        showCount: row?.show_count ?? 0,
        qualityBreakdown: {
          count4k: row?.count_4k ?? 0,
          count1080p: row?.count_1080p ?? 0,
          count720p: row?.count_720p ?? 0,
          countSd: row?.count_sd ?? 0,
        },
        asOf: row?.as_of ?? null,
        byServer: Object.keys(byServer).length > 0 ? byServer : undefined,
      };

      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_STATS, JSON.stringify(stats));

      return stats;
    }
  );
};
