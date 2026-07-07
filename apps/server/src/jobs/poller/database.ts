/**
 * Poller Database Operations
 *
 * Database query functions used by the poller.
 * Includes batch loading for performance optimization and rule fetching.
 */

import { eq, and, desc, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  TIME_MS,
  SESSION_LIMITS,
  type Session,
  type Rule,
  type RuleParams,
  type RuleV2,
  type RuleConditions,
  type RuleActions,
  type ViolationSeverity,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions, rules, serverUsers } from '../../db/schema.js';
import { mapSessionRow } from './sessionMapper.js';

// ============================================================================
// Session Batch Loading
// ============================================================================

/**
 * Batch load recent sessions for multiple server users (eliminates N+1 in polling loop)
 *
 * This function fetches sessions from the last N hours for a batch of server users
 * in a single query, avoiding the performance penalty of querying per-user.
 *
 * @param serverUserIds - Array of server user IDs to load sessions for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Map of serverUserId -> Session[] for each server user
 *
 * @example
 * const sessionMap = await batchGetRecentUserSessions(['su-1', 'su-2', 'su-3']);
 * const user1Sessions = sessionMap.get('su-1') ?? [];
 */
export async function batchGetRecentUserSessions(
  serverUserIds: string[],
  hours = 24
): Promise<Map<string, Session[]>> {
  if (serverUserIds.length === 0) return new Map();

  const since = new Date(Date.now() - hours * TIME_MS.HOUR);
  const result = new Map<string, Session[]>();

  // Initialize empty arrays for all server users
  for (const serverUserId of serverUserIds) {
    result.set(serverUserId, []);
  }

  // Single query to get recent sessions for all server users using inArray
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.serverUserId, serverUserIds), gte(sessions.startedAt, since)))
    .orderBy(desc(sessions.startedAt));

  // Group by server user (limit per user to prevent memory issues)
  for (const s of recentSessions) {
    const userSessions = result.get(s.serverUserId) ?? [];
    if (userSessions.length < SESSION_LIMITS.MAX_RECENT_PER_USER) {
      userSessions.push(mapSessionRow(s));
    }
    result.set(s.serverUserId, userSessions);
  }

  return result;
}

/**
 * Batch load the sibling server_user ids for a set of identities in a single
 * query (eliminates a per-session/per-poll-tick lookup for cross-server rule
 * aggregation on merged identities).
 *
 * @param userIds - Array of identity (users.id) values to resolve
 * @returns Map of userId -> server_user ids belonging to that identity
 *
 * @example
 * const identityMap = await batchGetIdentityServerUserIds(['u-1', 'u-2']);
 * const idsForUser1 = identityMap.get('u-1') ?? [];
 */
export async function batchGetIdentityServerUserIds(
  userIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;

  const uniqueUserIds = [...new Set(userIds)];
  for (const userId of uniqueUserIds) {
    result.set(userId, []);
  }

  const rows = await db
    .select({ id: serverUsers.id, userId: serverUsers.userId })
    .from(serverUsers)
    .where(inArray(serverUsers.userId, uniqueUserIds));

  for (const row of rows) {
    const ids = result.get(row.userId) ?? [];
    ids.push(row.id);
    result.set(row.userId, ids);
  }

  return result;
}

// ============================================================================
// Rule Loading
// ============================================================================

/**
 * Get all active legacy (V1) rules for evaluation
 *
 * Only returns rules with type and params set (legacy format).
 * V2 rules using conditions/actions are evaluated by a separate system.
 *
 * @returns Array of active Rule objects
 *
 * @example
 * const rules = await getActiveRules();
 * // Evaluate each session against these rules
 */
export async function getActiveRules(): Promise<Rule[]> {
  // Filter for legacy rules that have type set (V2 rules have type=null)
  const activeRules = await db
    .select()
    .from(rules)
    .where(and(eq(rules.isActive, true), isNotNull(rules.type)));

  return activeRules.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type!,
    params: r.params as unknown as RuleParams,
    serverUserId: r.serverUserId,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Get all active V2 rules (rules with conditions/actions defined).
 *
 * V2 rules use the new conditions/actions format instead of the legacy type/params.
 * These rules are evaluated by the session lifecycle event system.
 *
 * @returns Array of active RuleV2 objects
 *
 * @example
 * const rulesV2 = await getActiveRulesV2();
 * // Evaluate session events against these rules
 */
export async function getActiveRulesV2(): Promise<RuleV2[]> {
  const activeRules = await db
    .select()
    .from(rules)
    .where(and(eq(rules.isActive, true), isNotNull(rules.conditions)));

  return activeRules.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    serverId: r.serverId,
    isActive: r.isActive,
    severity: (r.severity ?? 'warning') as ViolationSeverity,
    conditions: r.conditions as RuleConditions,
    actions: r.actions as RuleActions,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
