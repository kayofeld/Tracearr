/**
 * Ombi connector routes - configuration test, manual sync, health, and
 * requester-mapping management. All owner-gated (app.requireOwner).
 *
 * Contract: docs/architecture/ombi-api-contract.md §2-5.4.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  ombiTestConnectionSchema,
  ombiMappingUpsertSchema,
  type OmbiTestConnectionResponse,
  type OmbiStatusResponse,
  type OmbiMappingsResponse,
  type OmbiRequesterMapping,
  type OmbiPurgeResponse,
  type OmbiRequesterResolutionType,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { ombiRequests, ombiUserMappings, users } from '../db/schema.js';
import { OmbiService } from '../services/ombi.js';
import { SsrfBlockedError } from '../utils/ssrf.js';
import { getOmbiSettings, getSetting } from '../services/settings.js';
import {
  enqueueOmbiSync,
  isOmbiSyncRunning,
  buildRequesterResolver,
  invalidateOmbiCaches,
} from '../jobs/ombiSyncQueue.js';

export const ombiRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /ombi/test-connection - validates the SUBMITTED url/apiKey, not the
   * saved settings (contract §2). 400 only for malformed body / SSRF
   * rejection; remote-side failures always return 200 { success: false }.
   */
  app.post('/test-connection', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = ombiTestConnectionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    let ombi: OmbiService;
    try {
      ombi = new OmbiService(body.data.url, body.data.apiKey);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return reply.badRequest(error.message);
      }
      return reply.badRequest(
        error instanceof Error ? error.message : 'Invalid Ombi configuration'
      );
    }

    const result = await ombi.testConnection();
    return result satisfies OmbiTestConnectionResponse;
  });

  /**
   * POST /ombi/sync - manual sync trigger (contract §3).
   * 202 { jobId } enqueued / 409 already running / 400 not configured.
   */
  app.post('/sync', { preHandler: [app.requireOwner] }, async (request, reply) => {
    try {
      const jobId = await enqueueOmbiSync(request.user.userId);
      return await reply.code(202).send({ jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue Ombi sync';
      if (message.includes('not configured')) {
        return reply.badRequest(message);
      }
      if (message.includes('already in progress')) {
        return reply.conflict(message);
      }
      app.log.error({ err: error }, 'Failed to enqueue Ombi sync');
      return reply.internalServerError(message);
    }
  });

  /**
   * GET /ombi/status - connector configuration + sync health (contract §4).
   * counts/attribution/mediaMatch are computed on demand from ombi_requests
   * so they never go stale between sync runs (a mapping change or purge
   * takes effect immediately - see services/settings.ts OmbiSyncStatusInternal).
   */
  app.get('/status', { preHandler: [app.requireOwner] }, async () => {
    const config = await getOmbiSettings();
    const configured = Boolean(config.ombiUrl && config.ombiApiKey);
    const status = await getSetting('ombiSyncStatus');
    const running = await isOmbiSyncRunning();

    const countsResult = await db.execute(sql`
      SELECT media_type AS "mediaType", COUNT(*)::int AS "count"
      FROM ombi_requests
      GROUP BY media_type
    `);
    let movieRequests = 0;
    let tvRequests = 0;
    for (const row of countsResult.rows as Array<{ mediaType: string; count: number }>) {
      if (row.mediaType === 'movie') movieRequests = row.count;
      else if (row.mediaType === 'tv') tvRequests = row.count;
    }
    const total = movieRequests + tvRequests;

    const attributionResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE match_method IN ('username', 'provider'))::int AS "matched",
        COUNT(*) FILTER (WHERE match_method = 'manual')::int AS "manual",
        COUNT(*) FILTER (WHERE user_id IS NULL)::int AS "unattributed"
      FROM ombi_requests
    `);
    const attribution = (attributionResult.rows[0] ?? {
      matched: 0,
      manual: 0,
      unattributed: 0,
    }) as { matched: number; manual: number; unattributed: number };

    // Query-time external-id join to library_items (ADR 0003) - imdb -> tmdb -> tvdb precedence.
    const mediaMatchResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE li.id IS NOT NULL)::int AS "matched",
        COUNT(*) FILTER (WHERE li.id IS NULL)::int AS "unmatched"
      FROM ombi_requests r
      LEFT JOIN LATERAL (
        SELECT li.id FROM library_items li
        WHERE li.media_type = (CASE WHEN r.media_type = 'movie' THEN 'movie' ELSE 'show' END)
          AND (
            (r.imdb_id IS NOT NULL AND li.imdb_id = r.imdb_id)
            OR (r.tmdb_id IS NOT NULL AND li.tmdb_id = r.tmdb_id)
            OR (r.tvdb_id IS NOT NULL AND li.tvdb_id = r.tvdb_id)
          )
        LIMIT 1
      ) li ON true
    `);
    const mediaMatch = (mediaMatchResult.rows[0] ?? { matched: 0, unmatched: 0 }) as {
      matched: number;
      unmatched: number;
    };

    const response: OmbiStatusResponse = {
      configured,
      running,
      lastRunAt: status?.lastRunAt ?? null,
      lastSuccessAt: status?.lastSuccessAt ?? null,
      lastError: status?.lastError ?? null,
      counts: {
        movieRequests,
        tvRequests,
        total,
        skippedValidation: status?.skippedValidation ?? 0,
      },
      purgeAvailable: !configured && total > 0,
      attribution,
      mediaMatch,
    };
    return response;
  });

  /**
   * GET /ombi/mappings - requester list with current resolution, ambiguity,
   * and suggestions for the mapping UI (contract §5.1).
   */
  app.get('/mappings', { preHandler: [app.requireOwner] }, async () => {
    const [requesterResult, countResult, mappingRows, userRows] = await Promise.all([
      db.execute(sql`
        SELECT DISTINCT ON (ombi_user_id)
          ombi_user_id AS "ombiUserId",
          ombi_username AS "ombiUsername",
          ombi_alias AS "ombiAlias",
          user_id AS "userId",
          match_method AS "matchMethod"
        FROM ombi_requests
        ORDER BY ombi_user_id, synced_at DESC
      `),
      db.execute(sql`
        SELECT ombi_user_id AS "ombiUserId", COUNT(*)::int AS "requestCount"
        FROM ombi_requests
        GROUP BY ombi_user_id
      `),
      db.select().from(ombiUserMappings),
      db.select({ id: users.id, username: users.username }).from(users),
    ]);

    interface RequesterRow {
      ombiUserId: string;
      ombiUsername: string;
      ombiAlias: string | null;
      userId: string | null;
      matchMethod: 'manual' | 'provider' | 'username' | null;
    }
    const requesterRows = requesterResult.rows as unknown as RequesterRow[];
    const countRows = countResult.rows as Array<{ ombiUserId: string; requestCount: number }>;
    const countByUser = new Map(countRows.map((r) => [r.ombiUserId, r.requestCount]));

    const usernameCandidates = new Map<string, Array<{ userId: string; username: string }>>();
    const usernameById = new Map<string, string>();
    for (const u of userRows) {
      usernameById.set(u.id, u.username);
      const key = u.username.toLowerCase();
      const arr = usernameCandidates.get(key) ?? [];
      arr.push({ userId: u.id, username: u.username });
      usernameCandidates.set(key, arr);
    }

    const seenOmbiUserIds = new Set(requesterRows.map((r) => r.ombiUserId));

    const liveRequesters: OmbiRequesterMapping[] = requesterRows.map((row) => {
      const type: OmbiRequesterResolutionType = row.matchMethod ?? 'unattributed';
      const resolved =
        row.matchMethod === 'username' ||
        row.matchMethod === 'provider' ||
        (row.matchMethod === 'manual' && row.userId !== null);
      const candidates = usernameCandidates.get(row.ombiUsername.toLowerCase()) ?? [];

      return {
        ombiUserId: row.ombiUserId,
        ombiUsername: row.ombiUsername,
        ombiAlias: row.ombiAlias,
        requestCount: countByUser.get(row.ombiUserId) ?? 0,
        resolution: {
          type,
          userId: row.userId,
          username: row.userId ? (usernameById.get(row.userId) ?? null) : null,
        },
        ambiguous: candidates.length > 1,
        suggestions: resolved ? [] : candidates,
        stale: false,
      };
    });

    // Mapping rows for requesters no longer present in ombi_requests (contract §5.1).
    const staleMappings: OmbiRequesterMapping[] = mappingRows
      .filter((m) => !seenOmbiUserIds.has(m.ombiUserId))
      .map((m) => ({
        ombiUserId: m.ombiUserId,
        ombiUsername: m.ombiUsername,
        ombiAlias: null,
        requestCount: 0,
        resolution: {
          type: 'manual' as const,
          userId: m.userId,
          username: m.userId ? (usernameById.get(m.userId) ?? null) : null,
        },
        ambiguous: false,
        suggestions: [],
        stale: true,
      }));

    const response: OmbiMappingsResponse = { requesters: [...liveRequesters, ...staleMappings] };
    return response;
  });

  /**
   * PUT /ombi/mappings/:ombiUserId - set/force a manual mapping (contract §5.2).
   * userId: null forces "unattributed" (owner explicitly ignores this requester).
   */
  app.put<{ Params: { ombiUserId: string } }>(
    '/mappings/:ombiUserId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const body = ombiMappingUpsertSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }
      const { ombiUserId } = request.params;
      const { userId } = body.data;

      if (userId !== null) {
        const [target] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!target) {
          return reply.notFound(`Unknown userId '${userId}'`);
        }
      }

      // Snapshot a display username for the mapping row: prefer a live request,
      // fall back to a prior mapping snapshot, and finally the id itself so the
      // insert never fails even for a not-yet-seen Ombi account.
      const [existingRequestRow] = await db
        .select({ ombiUsername: ombiRequests.ombiUsername })
        .from(ombiRequests)
        .where(eq(ombiRequests.ombiUserId, ombiUserId))
        .limit(1);
      const [existingMappingRow] = await db
        .select({ ombiUsername: ombiUserMappings.ombiUsername })
        .from(ombiUserMappings)
        .where(eq(ombiUserMappings.ombiUserId, ombiUserId))
        .limit(1);
      const ombiUsername =
        existingRequestRow?.ombiUsername ?? existingMappingRow?.ombiUsername ?? ombiUserId;

      await db
        .insert(ombiUserMappings)
        .values({ ombiUserId, ombiUsername, userId })
        .onConflictDoUpdate({
          target: ombiUserMappings.ombiUserId,
          set: { ombiUsername, userId, updatedAt: new Date() },
        });

      const updatedRows = await db
        .update(ombiRequests)
        .set({ userId, matchMethod: 'manual', updatedAt: new Date() })
        .where(eq(ombiRequests.ombiUserId, ombiUserId))
        .returning({ id: ombiRequests.id });

      await invalidateOmbiCaches(app.redis);

      return { updated: updatedRows.length };
    }
  );

  /**
   * DELETE /ombi/mappings/:ombiUserId - revert to the automatic pipeline
   * (contract §5.3). Provider tier is skipped here: providerUserId is never
   * persisted (design §7 PII minimization), so a live re-resolution without
   * a fresh Ombi payload can only run manual -> username -> unattributed;
   * the provider tier still applies at the next full sync.
   */
  app.delete<{ Params: { ombiUserId: string } }>(
    '/mappings/:ombiUserId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const { ombiUserId } = request.params;

      const deleted = await db
        .delete(ombiUserMappings)
        .where(eq(ombiUserMappings.ombiUserId, ombiUserId))
        .returning({ ombiUserId: ombiUserMappings.ombiUserId });

      if (deleted.length === 0) {
        return reply.notFound('No override exists for this Ombi requester');
      }

      const [sample] = await db
        .select({ ombiUsername: ombiRequests.ombiUsername })
        .from(ombiRequests)
        .where(eq(ombiRequests.ombiUserId, ombiUserId))
        .limit(1);

      let updated = 0;
      if (sample) {
        const resolver = await buildRequesterResolver();
        const resolution = resolver.resolve({
          ombiUserId,
          ombiUsername: sample.ombiUsername,
          ombiAlias: null,
          providerUserId: null,
        });
        const updatedRows = await db
          .update(ombiRequests)
          .set({
            userId: resolution.userId,
            matchMethod: resolution.matchMethod,
            updatedAt: new Date(),
          })
          .where(eq(ombiRequests.ombiUserId, ombiUserId))
          .returning({ id: ombiRequests.id });
        updated = updatedRows.length;
      }

      await invalidateOmbiCaches(app.redis);

      return { updated };
    }
  );

  /**
   * DELETE /ombi/data - purge mirrored request data (contract §5.4).
   * 409 while still configured - otherwise the next scheduled sync would
   * simply repopulate what was just deleted.
   */
  app.delete('/data', { preHandler: [app.requireOwner] }, async (_request, reply) => {
    const config = await getOmbiSettings();
    const configured = Boolean(config.ombiUrl && config.ombiApiKey);
    if (configured) {
      return reply.conflict('Disconnect the Ombi connector (clear URL and API key) before purging');
    }

    const { deletedRequests, deletedMappings } = await db.transaction(async (tx) => {
      const reqRows = await tx.delete(ombiRequests).returning({ id: ombiRequests.id });
      const mapRows = await tx
        .delete(ombiUserMappings)
        .returning({ ombiUserId: ombiUserMappings.ombiUserId });
      return { deletedRequests: reqRows.length, deletedMappings: mapRows.length };
    });

    await invalidateOmbiCaches(app.redis);

    const response: OmbiPurgeResponse = { deletedRequests, deletedMappings };
    return response;
  });
};
