/**
 * Seerr connector routes - configuration test, manual sync, health, and
 * requester-mapping management. All owner-gated (app.requireOwner).
 *
 * Contract: docs/architecture/seerr-api-contract.md §2-5.4.
 * Model/precedent: routes/ombi.ts - cloned closely, generalized to the shared
 * media_requests / media_request_user_mappings tables (ADR 0006), every
 * statement scoped `source = 'seerr'` (design §4.4 scoping checklist) so a
 * Seerr sync/mapping/purge never reads or writes an Ombi row.
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  seerrTestConnectionSchema,
  seerrMappingUpsertSchema,
  type SeerrTestConnectionResponse,
  type SeerrStatusResponse,
  type SeerrMappingsResponse,
  type SeerrRequesterMapping,
  type SeerrPurgeResponse,
  type SeerrRequesterResolutionType,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { mediaRequests, mediaRequestUserMappings, serverUsers, users } from '../db/schema.js';
import { SeerrService } from '../services/seerr.js';
import { SsrfBlockedError } from '../utils/ssrf.js';
import { getSeerrSettings, getSetting } from '../services/settings.js';
import {
  enqueueSeerrSync,
  isSeerrSyncRunning,
  buildSeerrRequesterResolver,
  invalidateSeerrCaches,
} from '../jobs/seerrSyncQueue.js';

/** Matches media_requests.source_user_id / media_request_user_mappings.source_user_id
 * (varchar(64), db/schema.ts). A longer :seerrUserId path param otherwise
 * reaches an insert/update unvalidated and produces an unhandled Postgres
 * error -> 500 (SEC-05) - reject it at the route boundary instead. */
const SEERR_USER_ID_MAX_LENGTH = 64;

export const seerrRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /seerr/test-connection - validates the SUBMITTED url/apiKey, not the
   * saved settings (contract §2). 400 only for malformed body / SSRF
   * rejection; remote-side failures always return 200 { success: false }.
   */
  app.post('/test-connection', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = seerrTestConnectionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    let seerr: SeerrService;
    try {
      seerr = new SeerrService(body.data.url, body.data.apiKey);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return reply.badRequest(error.message);
      }
      return reply.badRequest(
        error instanceof Error ? error.message : 'Invalid Seerr configuration'
      );
    }

    const result = await seerr.testConnection();
    return result satisfies SeerrTestConnectionResponse;
  });

  /**
   * POST /seerr/sync - manual sync trigger (contract §3).
   * 202 { jobId } enqueued / 409 already running / 400 not configured.
   */
  app.post('/sync', { preHandler: [app.requireOwner] }, async (request, reply) => {
    try {
      const jobId = await enqueueSeerrSync(request.user.userId);
      return await reply.code(202).send({ jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue Seerr sync';
      if (message.includes('not configured')) {
        return reply.badRequest(message);
      }
      if (message.includes('already in progress')) {
        return reply.conflict(message);
      }
      app.log.error({ err: error }, 'Failed to enqueue Seerr sync');
      return reply.internalServerError(message);
    }
  });

  /**
   * GET /seerr/status - connector configuration + sync health (contract §4).
   * counts/attribution/mediaMatch are computed on demand from media_requests
   * (source='seerr') so they never go stale between sync runs (a mapping
   * change or purge takes effect immediately).
   */
  app.get('/status', { preHandler: [app.requireOwner] }, async () => {
    const config = await getSeerrSettings();
    const configured = Boolean(config.seerrUrl && config.seerrApiKey);
    const status = await getSetting('seerrSyncStatus');
    const running = await isSeerrSyncRunning();

    const countsResult = await db.execute(sql`
      SELECT media_type AS "mediaType", COUNT(*)::int AS "count"
      FROM media_requests
      WHERE source = 'seerr'
      GROUP BY media_type
    `);
    let movieRequests = 0;
    let tvRequests = 0;
    for (const row of countsResult.rows as Array<{ mediaType: string; count: number }>) {
      if (row.mediaType === 'movie') movieRequests = row.count;
      else if (row.mediaType === 'tv') tvRequests = row.count;
    }
    const total = movieRequests + tvRequests;

    // user_id IS NOT NULL is required alongside match_method (OMB-6 precedent):
    // the FK is ON DELETE SET NULL, so a deleted Tracearr user leaves
    // match_method populated but user_id null - without this guard the row
    // double-counts as both matched/manual AND unattributed.
    const attributionResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE match_method IN ('username', 'provider') AND user_id IS NOT NULL)::int AS "matched",
        COUNT(*) FILTER (WHERE match_method = 'manual' AND user_id IS NOT NULL)::int AS "manual",
        COUNT(*) FILTER (WHERE user_id IS NULL)::int AS "unattributed"
      FROM media_requests
      WHERE source = 'seerr'
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
      FROM media_requests r
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
      WHERE r.source = 'seerr'
    `);
    const mediaMatch = (mediaMatchResult.rows[0] ?? { matched: 0, unmatched: 0 }) as {
      matched: number;
      unmatched: number;
    };

    // Purge (DELETE /seerr/data) also deletes media_request_user_mappings
    // (source='seerr') - if every request row was pruned but manual override
    // mappings remain, the purge control must still surface (OMB-5 precedent).
    const mappingCountResult = await db.execute(sql`
      SELECT COUNT(*)::int AS "count" FROM media_request_user_mappings WHERE source = 'seerr'
    `);
    const mappingCount = (mappingCountResult.rows[0] as { count: number } | undefined)?.count ?? 0;

    const response: SeerrStatusResponse = {
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
      purgeAvailable: !configured && (total > 0 || mappingCount > 0),
      attribution,
      mediaMatch,
    };
    return response;
  });

  /**
   * GET /seerr/mappings - requester list with current resolution, ambiguity,
   * and suggestions for the mapping UI (contract §5.1). Ambiguity/suggestions
   * consider BOTH match tiers (external id and username - ADR 0008), since
   * either can refuse to auto-resolve.
   */
  app.get('/mappings', { preHandler: [app.requireOwner] }, async () => {
    const [requesterResult, countResult, mappingRows, userRows, serverUserRows] = await Promise.all(
      [
        db.execute(sql`
          SELECT DISTINCT ON (source_user_id)
            source_user_id AS "seerrUserId",
            source_username AS "seerrUsername",
            source_alias AS "seerrAlias",
            source_external_user_id AS "sourceExternalUserId",
            user_id AS "userId",
            match_method AS "matchMethod"
          FROM media_requests
          WHERE source = 'seerr'
          ORDER BY source_user_id, synced_at DESC
        `),
        db.execute(sql`
          SELECT source_user_id AS "seerrUserId", COUNT(*)::int AS "requestCount"
          FROM media_requests
          WHERE source = 'seerr'
          GROUP BY source_user_id
        `),
        db
          .select()
          .from(mediaRequestUserMappings)
          .where(eq(mediaRequestUserMappings.source, 'seerr')),
        db.select({ id: users.id, username: users.username }).from(users),
        db
          .select({
            externalId: serverUsers.externalId,
            plexAccountId: serverUsers.plexAccountId,
            userId: serverUsers.userId,
          })
          .from(serverUsers),
      ]
    );

    interface RequesterRow {
      seerrUserId: string;
      seerrUsername: string;
      seerrAlias: string | null;
      sourceExternalUserId: string | null;
      userId: string | null;
      matchMethod: 'manual' | 'provider' | 'username' | null;
    }
    const requesterRows = requesterResult.rows as unknown as RequesterRow[];
    const countRows = countResult.rows as Array<{ seerrUserId: string; requestCount: number }>;
    const countByUser = new Map(countRows.map((r) => [r.seerrUserId, r.requestCount]));

    const usernameById = new Map<string, string>();
    const usernameCandidates = new Map<string, Array<{ userId: string; username: string }>>();
    for (const u of userRows) {
      usernameById.set(u.id, u.username);
      const key = u.username.toLowerCase();
      const arr = usernameCandidates.get(key) ?? [];
      arr.push({ userId: u.id, username: u.username });
      usernameCandidates.set(key, arr);
    }

    // External-id candidates (union of external_id / plex_account_id, same
    // rule as buildSeerrRequesterResolver - design §8.2).
    const externalIdCandidates = new Map<string, Array<{ userId: string; username: string }>>();
    const addExternalCandidate = (key: string | null, userId: string) => {
      if (!key) return;
      const arr = externalIdCandidates.get(key) ?? [];
      if (!arr.some((c) => c.userId === userId)) {
        arr.push({ userId, username: usernameById.get(userId) ?? userId });
      }
      externalIdCandidates.set(key, arr);
    };
    for (const su of serverUserRows) {
      addExternalCandidate(su.externalId, su.userId);
      addExternalCandidate(su.plexAccountId, su.userId);
    }

    const seenSeerrUserIds = new Set(requesterRows.map((r) => r.seerrUserId));

    const liveRequesters: SeerrRequesterMapping[] = requesterRows.map((row) => {
      const type: SeerrRequesterResolutionType = row.matchMethod ?? 'unattributed';
      // userId !== null is required for ALL match methods, not just 'manual'
      // (OMB-6 precedent): the FK is ON DELETE SET NULL, so a deleted
      // Tracearr user leaves match_method populated with userId null.
      const resolved =
        row.userId !== null &&
        (row.matchMethod === 'username' ||
          row.matchMethod === 'provider' ||
          row.matchMethod === 'manual');

      const externalCandidates = row.sourceExternalUserId
        ? (externalIdCandidates.get(row.sourceExternalUserId) ?? [])
        : [];
      const usernameCands = usernameCandidates.get(row.seerrUsername.toLowerCase()) ?? [];
      // CR-4: gated on !resolved (contract §5.1 - "auto-match refused"). A
      // requester that already resolved deterministically (e.g. via its
      // persisted external id) is not "refused" just because its username
      // separately happens to collide with another user - that used to mark
      // it ambiguous anyway, which pushed already-resolved rows above
      // genuinely unresolved ones in the mappings dialog's sort.
      const ambiguous = !resolved && (externalCandidates.length > 1 || usernameCands.length > 1);
      const suggestions = resolved
        ? []
        : externalCandidates.length > 0
          ? externalCandidates
          : usernameCands;

      return {
        seerrUserId: row.seerrUserId,
        seerrUsername: row.seerrUsername,
        seerrDisplayName: row.seerrAlias,
        requestCount: countByUser.get(row.seerrUserId) ?? 0,
        resolution: {
          type,
          userId: row.userId,
          username: row.userId ? (usernameById.get(row.userId) ?? null) : null,
        },
        ambiguous,
        suggestions,
        stale: false,
      };
    });

    // Mapping rows for requesters no longer present in media_requests (contract §5.1).
    const staleMappings: SeerrRequesterMapping[] = mappingRows
      .filter((m) => !seenSeerrUserIds.has(m.sourceUserId))
      .map((m) => ({
        seerrUserId: m.sourceUserId,
        seerrUsername: m.sourceUsername,
        seerrDisplayName: null,
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

    const response: SeerrMappingsResponse = {
      requesters: [...liveRequesters, ...staleMappings],
    };
    return response;
  });

  /**
   * PUT /seerr/mappings/:seerrUserId - set/force a manual mapping (contract §5.2).
   * userId: null forces "unattributed" (owner explicitly ignores this requester).
   */
  app.put<{ Params: { seerrUserId: string } }>(
    '/mappings/:seerrUserId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const body = seerrMappingUpsertSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }
      const { seerrUserId } = request.params;
      if (seerrUserId.length > SEERR_USER_ID_MAX_LENGTH) {
        return reply.badRequest(
          `seerrUserId must be at most ${SEERR_USER_ID_MAX_LENGTH} characters`
        );
      }
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

      // Snapshot a display username for the mapping row: prefer a live
      // request, fall back to a prior mapping snapshot, and finally the id
      // itself so the insert never fails even for a not-yet-seen Seerr account.
      const [existingRequestRow] = await db
        .select({ sourceUsername: mediaRequests.sourceUsername })
        .from(mediaRequests)
        .where(and(eq(mediaRequests.source, 'seerr'), eq(mediaRequests.sourceUserId, seerrUserId)))
        .limit(1);
      const [existingMappingRow] = await db
        .select({ sourceUsername: mediaRequestUserMappings.sourceUsername })
        .from(mediaRequestUserMappings)
        .where(
          and(
            eq(mediaRequestUserMappings.source, 'seerr'),
            eq(mediaRequestUserMappings.sourceUserId, seerrUserId)
          )
        )
        .limit(1);
      const sourceUsername =
        existingRequestRow?.sourceUsername ?? existingMappingRow?.sourceUsername ?? seerrUserId;

      await db
        .insert(mediaRequestUserMappings)
        .values({ source: 'seerr', sourceUserId: seerrUserId, sourceUsername, userId })
        .onConflictDoUpdate({
          target: [mediaRequestUserMappings.source, mediaRequestUserMappings.sourceUserId],
          set: { sourceUsername, userId, updatedAt: new Date() },
        });

      const updatedRows = await db
        .update(mediaRequests)
        .set({ userId, matchMethod: 'manual', updatedAt: new Date() })
        .where(and(eq(mediaRequests.source, 'seerr'), eq(mediaRequests.sourceUserId, seerrUserId)))
        .returning({ id: mediaRequests.id });

      await invalidateSeerrCaches(app.redis);

      return { updated: updatedRows.length };
    }
  );

  /**
   * DELETE /seerr/mappings/:seerrUserId - revert to the automatic pipeline
   * (contract §5.3). Unlike Ombi, the FULL pipeline runs here (including the
   * external-id tier) because source_external_user_id is persisted on the
   * request row (ADR 0008) - no live Seerr payload is needed to use it.
   */
  app.delete<{ Params: { seerrUserId: string } }>(
    '/mappings/:seerrUserId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const { seerrUserId } = request.params;
      if (seerrUserId.length > SEERR_USER_ID_MAX_LENGTH) {
        return reply.badRequest(
          `seerrUserId must be at most ${SEERR_USER_ID_MAX_LENGTH} characters`
        );
      }

      const deleted = await db
        .delete(mediaRequestUserMappings)
        .where(
          and(
            eq(mediaRequestUserMappings.source, 'seerr'),
            eq(mediaRequestUserMappings.sourceUserId, seerrUserId)
          )
        )
        .returning({ sourceUserId: mediaRequestUserMappings.sourceUserId });

      if (deleted.length === 0) {
        return reply.notFound('No override exists for this Seerr requester');
      }

      const [sample] = await db
        .select({
          sourceUsername: mediaRequests.sourceUsername,
          sourceExternalUserId: mediaRequests.sourceExternalUserId,
        })
        .from(mediaRequests)
        .where(and(eq(mediaRequests.source, 'seerr'), eq(mediaRequests.sourceUserId, seerrUserId)))
        .limit(1);

      let updated = 0;
      if (sample) {
        const resolver = await buildSeerrRequesterResolver();
        const resolution = resolver.resolve({
          seerrUserId,
          seerrUsername: sample.sourceUsername,
          seerrAlias: null,
          externalUserId: sample.sourceExternalUserId,
        });
        const updatedRows = await db
          .update(mediaRequests)
          .set({
            userId: resolution.userId,
            matchMethod: resolution.matchMethod,
            updatedAt: new Date(),
          })
          .where(
            and(eq(mediaRequests.source, 'seerr'), eq(mediaRequests.sourceUserId, seerrUserId))
          )
          .returning({ id: mediaRequests.id });
        updated = updatedRows.length;
      }

      await invalidateSeerrCaches(app.redis);

      return { updated };
    }
  );

  /**
   * DELETE /seerr/data - purge mirrored request data (contract §5.4).
   * 409 while still configured - otherwise the next scheduled sync would
   * simply repopulate what was just deleted. Scoped `source = 'seerr'` on
   * both tables - never touches Ombi rows.
   */
  app.delete('/data', { preHandler: [app.requireOwner] }, async (_request, reply) => {
    const config = await getSeerrSettings();
    const configured = Boolean(config.seerrUrl && config.seerrApiKey);
    if (configured) {
      return reply.conflict(
        'Disconnect the Seerr connector (clear URL and API key) before purging'
      );
    }

    const { deletedRequests, deletedMappings } = await db.transaction(async (tx) => {
      const reqRows = await tx
        .delete(mediaRequests)
        .where(eq(mediaRequests.source, 'seerr'))
        .returning({ id: mediaRequests.id });
      const mapRows = await tx
        .delete(mediaRequestUserMappings)
        .where(eq(mediaRequestUserMappings.source, 'seerr'))
        .returning({ sourceUserId: mediaRequestUserMappings.sourceUserId });
      return { deletedRequests: reqRows.length, deletedMappings: mapRows.length };
    });

    await invalidateSeerrCaches(app.redis);

    const response: SeerrPurgeResponse = { deletedRequests, deletedMappings };
    return response;
  });
};
