/**
 * User merge service
 *
 * Implements the users-level merge from the auth overhaul design:
 * absorb a source identity into a target identity, combine same-server
 * accounts, record an audit row, and support split as the undo path.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { canLogin, type UserRole } from '@tracearr/shared';
import type { UserMergeResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import {
  users,
  serverUsers,
  sessions,
  violations,
  rules,
  plexAccounts,
  mobileSessions,
  mobileTokens,
  terminationLogs,
  authAccounts,
  userMergeAudits,
} from '../db/schema.js';
import { getAuth } from '../lib/auth.js';
import { UserNotFoundError } from './userService.js';

export interface MergeIdentitySnapshot {
  id: string;
  role: UserRole;
  passwordHash: string | null;
  plexAccountId: string | null;
  linkedPlexAccountCount: number;
  // Better Auth account rows for this user, any provider (credential/plex/OIDC).
  // Tracked separately from passwordHash because users.password_hash is
  // scheduled to be dropped in a later cleanup release.
  authAccountCount: number;
}

export class MergeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeValidationError';
    Object.setPrototypeOf(this, MergeValidationError.prototype);
  }
}

export class MergeDirectionError extends MergeValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'MergeDirectionError';
    Object.setPrototypeOf(this, MergeDirectionError.prototype);
  }
}

export class SameServerCombineNotConfirmedError extends MergeValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SameServerCombineNotConfirmedError';
    Object.setPrototypeOf(this, SameServerCombineNotConfirmedError.prototype);
  }
}

export function isLoginCapable(user: MergeIdentitySnapshot): boolean {
  return (
    canLogin(user.role) ||
    user.passwordHash !== null ||
    user.plexAccountId !== null ||
    user.linkedPlexAccountCount > 0 ||
    user.authAccountCount > 0
  );
}

export function assertMergeDirection(
  source: MergeIdentitySnapshot,
  target: MergeIdentitySnapshot
): void {
  void target;
  if (isLoginCapable(source)) {
    throw new MergeDirectionError(
      'A login-capable account can only be the target of a merge, never the absorbed side'
    );
  }
}

export interface ServerUserRef {
  id: string;
  serverId: string;
}

export interface MergePlan {
  repointServerUserIds: string[];
  combines: { sourceServerUserId: string; targetServerUserId: string; serverId: string }[];
}

export function planServerUserMoves(
  sourceServerUsers: ServerUserRef[],
  targetServerUsers: ServerUserRef[]
): MergePlan {
  const targetByServer = new Map(targetServerUsers.map((su) => [su.serverId, su]));
  const plan: MergePlan = { repointServerUserIds: [], combines: [] };

  for (const sourceSu of sourceServerUsers) {
    const targetSu = targetByServer.get(sourceSu.serverId);
    if (targetSu) {
      plan.combines.push({
        sourceServerUserId: sourceSu.id,
        targetServerUserId: targetSu.id,
        serverId: sourceSu.serverId,
      });
    } else {
      plan.repointServerUserIds.push(sourceSu.id);
    }
  }

  return plan;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadIdentitySnapshot(tx: Tx, userId: string): Promise<MergeIdentitySnapshot> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new UserNotFoundError(userId);
  }
  const [plexCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(plexAccounts)
    .where(eq(plexAccounts.userId, userId));
  const [authAccountCountRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId));
  return {
    id: user.id,
    role: user.role,
    passwordHash: user.passwordHash,
    plexAccountId: user.plexAccountId,
    linkedPlexAccountCount: plexCount?.count ?? 0,
    authAccountCount: authAccountCountRow?.count ?? 0,
  };
}

async function recomputeIdentityAggregates(tx: Tx, userId: string): Promise<void> {
  const [trust] = await tx
    .select({
      weightedSum: sql<number>`coalesce(sum(${serverUsers.trustScore}::numeric * ${serverUsers.sessionCount}), 0)`,
      totalSessions: sql<number>`coalesce(sum(${serverUsers.sessionCount}), 0)`,
    })
    .from(serverUsers)
    .where(eq(serverUsers.userId, userId));

  const totalSessions = Number(trust?.totalSessions ?? 0);
  const aggregateScore =
    totalSessions > 0 ? Math.round(Number(trust?.weightedSum ?? 0) / totalSessions) : 100;

  const [violationCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(violations)
    .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
    .where(eq(serverUsers.userId, userId));

  await tx
    .update(users)
    .set({
      aggregateTrustScore: aggregateScore,
      totalViolations: violationCount?.count ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

async function repointIdentityRows(
  tx: Tx,
  sourceUserId: string,
  targetUserId: string
): Promise<void> {
  await tx
    .update(plexAccounts)
    .set({ userId: targetUserId })
    .where(eq(plexAccounts.userId, sourceUserId));
  await tx
    .update(mobileSessions)
    .set({ userId: targetUserId })
    .where(eq(mobileSessions.userId, sourceUserId));
  await tx
    .update(mobileTokens)
    .set({ createdBy: targetUserId })
    .where(eq(mobileTokens.createdBy, sourceUserId));
  await tx
    .update(terminationLogs)
    .set({ triggeredByUserId: targetUserId })
    .where(eq(terminationLogs.triggeredByUserId, sourceUserId));
  // Better Auth login rows (auth_accounts / auth_sessions) are deliberately
  // never touched here. assertMergeDirection already proved the source owns
  // zero auth_accounts rows, so there is nothing to repoint; its sessions are
  // revoked (not moved) through internalAdapter in mergeUsers instead, since
  // Better Auth has no primitive to re-key a session onto another user.
}

async function combineServerUsers(
  tx: Tx,
  sourceServerUserId: string,
  targetServerUserId: string
): Promise<void> {
  const [sourceSu] = await tx
    .select()
    .from(serverUsers)
    .where(eq(serverUsers.id, sourceServerUserId))
    .limit(1);
  const [targetSu] = await tx
    .select()
    .from(serverUsers)
    .where(eq(serverUsers.id, targetServerUserId))
    .limit(1);
  if (!sourceSu || !targetSu) {
    throw new MergeValidationError('server user disappeared during merge');
  }

  await tx
    .update(sessions)
    .set({ serverUserId: targetServerUserId })
    .where(eq(sessions.serverUserId, sourceServerUserId));
  await tx
    .update(violations)
    .set({ serverUserId: targetServerUserId })
    .where(eq(violations.serverUserId, sourceServerUserId));
  await tx
    .update(terminationLogs)
    .set({ serverUserId: targetServerUserId })
    .where(eq(terminationLogs.serverUserId, sourceServerUserId));

  // Per-user rule overrides: primary wins on name conflicts, the rest move over
  const targetRuleRows = await tx
    .select({ name: rules.name })
    .from(rules)
    .where(eq(rules.serverUserId, targetServerUserId));
  const targetRuleNames = new Set(targetRuleRows.map((r) => r.name));
  const sourceRuleRows = await tx
    .select({ id: rules.id, name: rules.name })
    .from(rules)
    .where(eq(rules.serverUserId, sourceServerUserId));
  for (const rule of sourceRuleRows) {
    if (targetRuleNames.has(rule.name)) {
      await tx.delete(rules).where(eq(rules.id, rule.id));
    } else {
      await tx
        .update(rules)
        .set({ serverUserId: targetServerUserId, updatedAt: new Date() })
        .where(eq(rules.id, rule.id));
    }
  }

  // Primary metadata wins; only null gaps are filled from the source.
  // removedAt is never carried over here: the source row is being folded
  // into a live target, so the surviving row must stay active even if the
  // source had been soft-removed (e.g. a re-created account absorbing the
  // history of an old, removed one).
  await tx
    .update(serverUsers)
    .set({
      email: targetSu.email ?? sourceSu.email,
      thumbUrl: targetSu.thumbUrl ?? sourceSu.thumbUrl,
      plexAccountId: targetSu.plexAccountId ?? sourceSu.plexAccountId,
      joinedAt:
        targetSu.joinedAt && sourceSu.joinedAt
          ? new Date(Math.min(targetSu.joinedAt.getTime(), sourceSu.joinedAt.getTime()))
          : (targetSu.joinedAt ?? sourceSu.joinedAt),
      lastActivityAt:
        targetSu.lastActivityAt && sourceSu.lastActivityAt
          ? new Date(Math.max(targetSu.lastActivityAt.getTime(), sourceSu.lastActivityAt.getTime()))
          : (targetSu.lastActivityAt ?? sourceSu.lastActivityAt),
      updatedAt: new Date(),
    })
    .where(eq(serverUsers.id, targetServerUserId));

  await tx.delete(serverUsers).where(eq(serverUsers.id, sourceServerUserId));

  const [sessionCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.serverUserId, targetServerUserId));
  await tx
    .update(serverUsers)
    .set({ sessionCount: sessionCount?.count ?? 0, updatedAt: new Date() })
    .where(eq(serverUsers.id, targetServerUserId));
}

export interface MergeUsersOptions {
  confirmSameServerCombine?: boolean;
}

export async function mergeUsers(
  sourceUserId: string,
  targetUserId: string,
  actingUserId: string,
  options: MergeUsersOptions = {}
): Promise<UserMergeResult> {
  if (sourceUserId === targetUserId) {
    throw new MergeValidationError('cannot merge an identity into itself');
  }

  const result = await db.transaction(async (tx) => {
    const source = await loadIdentitySnapshot(tx, sourceUserId);
    const target = await loadIdentitySnapshot(tx, targetUserId);
    assertMergeDirection(source, target);

    // The direction check above just proved the source owns zero auth_accounts
    // rows. Revoke its Better Auth sessions before any destructive write so a
    // ghost Redis session cannot keep working for up to 30 days after the
    // source row is deleted (deleting the row by SQL clears the DB session
    // rows via cascade but never touches the Redis secondary storage). This
    // writes through Better Auth's own connection, not this transaction: if
    // the transaction later aborts, the worst case is a revoked session for a
    // user who could not log in anyway (safe direction, fail-closed).
    await (await getAuth().$context).internalAdapter.deleteUserSessions(sourceUserId);

    const [sourceUser] = await tx.select().from(users).where(eq(users.id, sourceUserId)).limit(1);

    const sourceSus = await tx
      .select({ id: serverUsers.id, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.userId, sourceUserId));
    const targetSus = await tx
      .select({ id: serverUsers.id, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.userId, targetUserId));

    const plan = planServerUserMoves(sourceSus, targetSus);

    if (plan.combines.length > 0 && !options.confirmSameServerCombine) {
      throw new SameServerCombineNotConfirmedError(
        'both identities have an account on the same server; combining them is irreversible and requires explicit confirmation'
      );
    }

    for (const combine of plan.combines) {
      await combineServerUsers(tx, combine.sourceServerUserId, combine.targetServerUserId);
    }

    if (plan.repointServerUserIds.length > 0) {
      await tx
        .update(serverUsers)
        .set({ userId: targetUserId, updatedAt: new Date() })
        .where(inArray(serverUsers.id, plan.repointServerUserIds));
    }

    await repointIdentityRows(tx, sourceUserId, targetUserId);
    await recomputeIdentityAggregates(tx, targetUserId);

    await tx.delete(users).where(eq(users.id, sourceUserId));

    const [audit] = await tx
      .insert(userMergeAudits)
      .values({
        sourceUserId,
        targetUserId,
        actingUserId,
        movedServerUserIds: plan.repointServerUserIds,
        combinedServerUsers: plan.combines,
        wasSameServerCombine: plan.combines.length > 0,
        sourceUserSnapshot: {
          username: sourceUser!.username,
          name: sourceUser!.name,
          email: sourceUser!.email,
          thumbnail: sourceUser!.thumbnail,
          role: sourceUser!.role,
        },
      })
      .returning();

    return {
      targetUserId,
      auditId: audit!.id,
      movedServerUserIds: plan.repointServerUserIds,
      combinedServerUsers: plan.combines,
      wasSameServerCombine: plan.combines.length > 0,
    };
  });

  // recomputeIdentityAggregates wrote the target's columns with raw SQL,
  // which any live session's cached Redis snapshot never sees on its own
  // (the snapshot freezes the user object at write time). Refresh it here so
  // stale identity data does not survive until the snapshot expires (up to
  // 30 days).
  const authCtx = await getAuth().$context;
  const freshTarget = await authCtx.internalAdapter.findUserById(targetUserId);
  if (freshTarget) {
    await authCtx.internalAdapter.refreshUserSessions(freshTarget);
  }

  return result;
}
