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
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rules, sessions } from '../../db/schema.js';
import { getCacheService } from '../cache.js';
import {
  batchGetIdentityServerUserIds,
  batchGetRecentUserSessions,
  mapRuleRowToRuleV2,
} from '../../jobs/poller/database.js';
import { excludeUncountableSessions } from '../../jobs/poller/utils.js';
import { gracePeriodSessionIds } from '../../jobs/poller/processor.js';
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
  const { sessionId, serverId, ruleId, message } = params;

  const sessionRow = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: { server: true, serverUser: true },
  });

  if (!sessionRow || sessionRow.stoppedAt) {
    return { outcome: 'skipped_already_stopped' };
  }

  const [ruleRow] = await db.select().from(rules).where(eq(rules.id, ruleId)).limit(1);
  if (!ruleRow || !ruleRow.isActive || !ruleRow.conditions) {
    return { outcome: 'skipped_rule_gone' };
  }

  const rule = mapRuleRowToRuleV2(ruleRow);

  const cacheService = getCacheService();
  const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
  const activeSessions = excludeUncountableSessions(cachedSessions, gracePeriodSessionIds());

  const recentSessionsMap = await batchGetRecentUserSessions([sessionRow.serverUserId]);
  const recentSessions = recentSessionsMap.get(sessionRow.serverUserId) ?? [];

  // Only rules opted into cross-server enforcement need the sibling
  // server_user lookup - the overwhelming majority evaluate single-account.
  let identityServerUserIds: string[] | undefined;
  if (rule.enforceAcrossServers) {
    const identityMap = await batchGetIdentityServerUserIds([sessionRow.serverUser.userId]);
    identityServerUserIds = identityMap.get(sessionRow.serverUser.userId);
  }

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
