/**
 * Kill Queue Re-verification
 *
 * Re-checks a matched kill_stream condition against current state right
 * before the delayed termination fires. delay_seconds is the sustain window
 * between the original match and this check, so a session that stopped or a
 * condition that cleared in the meantime must abort rather than kill on
 * stale evidence. Builds its evaluation context through the same seams live
 * rule evaluation uses (excludeUncountableSessions, gracePeriodSessionIds,
 * evaluateRulesAsync) so re-verification and live evaluation can never
 * disagree about what counts as an active session.
 *
 * The cache is not a faithful stand-in for "current state" for the
 * triggering session specifically: createSessionWithRulesAtomic skips
 * re-adding it to the cache once a kill job is enqueued for it
 * (wasTerminatedByRule), so at delay_seconds 0 this can run before any poll
 * tick rediscovers it. buildRuleContextSessions (shared with live
 * evaluation) appends sessionRow back in when the cache list doesn't already
 * carry its id, the same way it appends a freshly-inserted session in
 * createSessionWithRulesAtomic.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rules, sessions } from '../../db/schema.js';
import { getCacheService } from '../cache.js';
import {
  batchGetIdentityServerUserIds,
  batchGetRecentUserSessions,
  mapRuleRowToRuleV2,
  widenRecentSessionsForMergedIdentities,
} from '../../jobs/poller/database.js';
import { excludeUncountableSessions } from '../../jobs/poller/utils.js';
import { gracePeriodSessionIds } from '../../jobs/poller/processor.js';
import { buildRuleContextSessions } from '../../jobs/poller/sessionLifecycle.js';
import { terminateSession } from '../termination.js';
import { rulesLogger } from '../../utils/logger.js';
import { evaluateRulesAsync } from './engine.js';
import type { EvaluationContext } from './types.js';

export type ReverifyOutcome =
  | 'killed'
  | 'skipped_already_stopped'
  | 'skipped_rule_gone'
  | 'skipped_condition_cleared'
  | 'failed';

export interface ReverifyKillConditionParams {
  sessionId: string;
  serverId: string;
  ruleId: string;
  /** Message to display to the user before termination (Plex only). */
  message?: string;
  /** True when a prior attempt of this same BullMQ job already ran (and
   *  failed after termination, e.g. storeActionResults threw). Narrows the
   *  already-stopped idempotency check below to retries only. */
  isRetry?: boolean;
}

export interface ReverifyKillConditionResult {
  outcome: ReverifyOutcome;
  error?: string;
}

/**
 * Re-verify a kill_stream match at fire time and terminate if it still holds.
 * Ownership of the actual termination call lives here rather than in the
 * queue worker, so a "matched" result and a "killed" outcome can never drift
 * apart.
 */
export async function reverifyKillCondition(
  params: ReverifyKillConditionParams
): Promise<ReverifyKillConditionResult> {
  const { sessionId, serverId, ruleId, message, isRetry } = params;

  const sessionRow = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: { server: true, serverUser: true },
  });

  if (!sessionRow) {
    return { outcome: 'skipped_already_stopped' };
  }

  if (sessionRow.stoppedAt) {
    // A retry only happens after a prior attempt of this exact job got past
    // termination and then threw (e.g. storeActionResults failing) - forceStopped
    // is already on the row we just fetched, so this costs no extra query and
    // avoids relabeling that earlier success as skipped_already_stopped. It
    // can't tell this job's kill apart from an unrelated forced stop (admin,
    // stale sweep) landing in the same narrow retry window; that tradeoff is
    // accepted given how rarely the two coincide within a few seconds.
    if (isRetry && sessionRow.forceStopped) {
      return { outcome: 'killed' };
    }
    return { outcome: 'skipped_already_stopped' };
  }

  const [ruleRow] = await db.select().from(rules).where(eq(rules.id, ruleId)).limit(1);
  if (!ruleRow || !ruleRow.isActive || !ruleRow.conditions) {
    return { outcome: 'skipped_rule_gone' };
  }

  const rule = mapRuleRowToRuleV2(ruleRow);

  const cacheService = getCacheService();
  const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
  const countableCachedSessions = excludeUncountableSessions(
    cachedSessions,
    gracePeriodSessionIds()
  );
  // sessionRow is missing from countableCachedSessions exactly when this kill
  // was enqueued for the triggering session (see module header) - append it
  // back so conditions like concurrent_streams count the session being
  // re-verified instead of undercounting it by one and self-aborting.
  //
  // KNOWN RESIDUAL: this only restores the triggering session. For
  // target: 'oldest'/'all_except_one' a kill can also target some OTHER
  // session that itself raced into existence after the last cache write; that
  // session is not sessionRow, so this fix doesn't reach it and a delay-0
  // re-check for those targets can still race rediscovery by milliseconds.
  // Accepted follow-up, not fixed here.
  const activeSessions = buildRuleContextSessions(countableCachedSessions, sessionRow, null);

  // Identity aggregation runs unconditionally here, mirroring the live poller
  // (processor.ts) - detection-side identity counting is NOT gated by
  // enforceAcrossServers, that flag only controls whether a MATCHED rule's
  // actions reach sessions beyond the triggering one. Gating this lookup on
  // the flag would let a kill matched under live evaluation's identity-wide
  // count re-verify with single-account context and wrongly self-abort as
  // skipped_condition_cleared. Always re-derived here from the DB rather than
  // trusting the identityServerUserIds snapshot the enqueue payload carries
  // from match time: identity membership (server merges/unmerges) can change
  // during the delay window between match and this re-check.
  const identityMap = await batchGetIdentityServerUserIds([sessionRow.serverUser.userId]);
  const identityServerUserIds = identityMap.get(sessionRow.serverUser.userId);

  const recentSessionsUserIds =
    identityServerUserIds && identityServerUserIds.length > 1
      ? identityServerUserIds
      : [sessionRow.serverUserId];
  const recentSessionsMap = await batchGetRecentUserSessions(recentSessionsUserIds);

  // Widen recentSessions across the identity's server_user ids so windowed
  // evaluators (unique_ips_in_window, travel_speed_kmh, ...) see the same
  // cross-server history live evaluation matched on, not just this session's
  // own account - otherwise a cross-server match can silently fail to
  // reproduce here and abort as skipped_condition_cleared.
  if (identityServerUserIds && identityServerUserIds.length > 1) {
    await widenRecentSessionsForMergedIdentities(
      recentSessionsMap,
      new Map([[sessionRow.serverUser.userId, identityServerUserIds]])
    );
  }

  const recentSessions = recentSessionsMap.get(sessionRow.serverUserId) ?? [];

  const baseContext: Omit<EvaluationContext, 'rule'> = {
    session: sessionRow,
    serverUser: sessionRow.serverUser,
    server: sessionRow.server,
    activeSessions,
    recentSessions,
    identityServerUserIds,
  };

  const results = await evaluateRulesAsync(baseContext, [rule]);
  const matched = results.some((r) => r.ruleId === rule.id && r.matched);

  if (!matched) {
    return { outcome: 'skipped_condition_cleared' };
  }

  try {
    const result = await terminateSession({
      sessionId,
      trigger: 'rule',
      ruleId,
      reason: message,
    });

    if (!result.success) {
      return { outcome: 'failed', error: result.error ?? 'Termination failed' };
    }

    rulesLogger.info('Kill queue: terminated session after re-verification', {
      sessionId,
      serverId,
      ruleId,
    });

    return { outcome: 'killed' };
  } catch (err) {
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : 'Unknown termination error',
    };
  }
}
