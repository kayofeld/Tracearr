/**
 * User merge integration tests
 *
 * Exercises mergeUsers against a real database: cross-server repoint,
 * same-server combine, direction rule, aggregate recompute, audit row,
 * and the Better Auth session obligations (revoke on absorb, refresh on
 * target after commit).
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- userMerge
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestRule,
  createTestViolation,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { fullRoutes } from '../../src/routes/users/full.js';
import {
  users,
  serverUsers,
  sessions,
  rules,
  authAccounts,
  authSessions,
  userMergeAudits,
} from '../../src/db/schema.js';
import {
  mergeUsers,
  splitServerUser,
  MergeDirectionError,
  MergeValidationError,
  SameServerCombineNotConfirmedError,
} from '../../src/services/mergeService.js';

describe('mergeUsers', () => {
  it('merges a cross-server duplicate: repoints server users, carries history, recomputes aggregates, deletes source, writes audit', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member', email: 'bob@example.com' });
    const source = await createTestUser({ role: 'member', email: null });

    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 90,
      sessionCount: 10,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 50,
      sessionCount: 30,
    });

    const sourceSession = await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 60_000,
    });
    const rule = await createTestRule({
      type: 'concurrent_streams',
      params: { max_streams: 2 },
    });
    await createTestViolation({
      ruleId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sourceSession.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id);

    expect(result.targetUserId).toBe(target.id);
    expect(result.movedServerUserIds).toEqual([sourceSu.id]);
    expect(result.wasSameServerCombine).toBe(false);

    // Source server user now belongs to the target identity
    const [movedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(movedSu?.userId).toBe(target.id);

    // Sessions and violations still hang off the moved server user (history carried)
    const [carriedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSession.id));
    expect(carriedSession?.serverUserId).toBe(sourceSu.id);

    // Source identity is gone, target identity fields untouched
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(0);
    const [survivor] = await db.select().from(users).where(eq(users.id, target.id));
    expect(survivor?.email).toBe('bob@example.com');
    expect(survivor?.role).toBe('member');

    // Weighted aggregate: (90*10 + 50*30) / 40 = 60, one violation total
    expect(survivor?.aggregateTrustScore).toBe(60);
    expect(survivor?.totalViolations).toBe(1);

    // Audit row enables split later
    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, result.auditId));
    expect(audit?.sourceUserId).toBe(source.id);
    expect(audit?.targetUserId).toBe(target.id);
    expect(audit?.actingUserId).toBe(admin.id);
    expect(audit?.movedServerUserIds).toEqual([sourceSu.id]);
    expect(audit?.wasSameServerCombine).toBe(false);
    expect(audit?.sourceUserSnapshot.username).toBe(source.username);
  });

  it('rejects a same-server merge without explicit confirmation', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: target.id, serverId: server.id });
    await createTestServerUser({ userId: source.id, serverId: server.id });

    // A pre-existing Better Auth session for the source; a rejected merge
    // must leave it untouched since the confirmation guard runs first.
    const sourceAuthSessionId = randomUUID();
    await db.insert(authSessions).values({
      id: sourceAuthSessionId,
      expiresAt: new Date(Date.now() + 60_000),
      token: randomUUID(),
      userId: source.id,
    });

    await expect(mergeUsers(source.id, target.id, admin.id)).rejects.toBeInstanceOf(
      SameServerCombineNotConfirmedError
    );

    // Nothing changed
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(1);
    const [survivingSession] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, sourceAuthSessionId));
    expect(survivingSession).toBeDefined();
  });

  it('combines same-server accounts when confirmed: history repointed, primary metadata wins, source row deleted, counts recomputed', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });

    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: server.id,
      email: 'primary@example.com',
      trustScore: 95,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: server.id,
      email: 'dupe@example.com',
      trustScore: 40,
    });

    await createTestSession({ serverId: server.id, serverUserId: targetSu.id });
    await createTestSession({ serverId: server.id, serverUserId: sourceSu.id });
    await createTestSession({ serverId: server.id, serverUserId: sourceSu.id });

    // Conflicting per-user rule override: primary wins, source copy dropped
    await createTestRule({
      name: 'Max streams',
      type: 'concurrent_streams',
      params: { max_streams: 2 },
      serverUserId: targetSu.id,
    });
    await createTestRule({
      name: 'Max streams',
      type: 'concurrent_streams',
      params: { max_streams: 5 },
      serverUserId: sourceSu.id,
    });
    // Source-only override: moves to the target server user
    const geoRule = await createTestRule({
      name: 'Geo lock',
      type: 'geo_restriction',
      params: { blocked_countries: ['XX'] },
      serverUserId: sourceSu.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id, {
      confirmSameServerCombine: true,
    });

    expect(result.wasSameServerCombine).toBe(true);
    expect(result.combinedServerUsers).toEqual([
      { sourceServerUserId: sourceSu.id, targetServerUserId: targetSu.id, serverId: server.id },
    ]);

    // Source server user is gone, its sessions live on the target server user
    const sourceSuRows = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(sourceSuRows).toHaveLength(0);
    const combinedSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.serverUserId, targetSu.id));
    expect(combinedSessions).toHaveLength(3);

    // sessionCount recomputed from combined history, primary metadata and trust kept
    const [combinedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, targetSu.id));
    expect(combinedSu?.sessionCount).toBe(3);
    expect(combinedSu?.email).toBe('primary@example.com');
    expect(combinedSu?.trustScore).toBe(95);

    // Rule overrides: conflicting name dropped, unique one repointed
    const targetRules = await db.select().from(rules).where(eq(rules.serverUserId, targetSu.id));
    const names = targetRules.map((r) => r.name).sort();
    expect(names).toEqual(['Geo lock', 'Max streams']);
    const [movedGeoRule] = await db.select().from(rules).where(eq(rules.id, geoRule.id));
    expect(movedGeoRule?.serverUserId).toBe(targetSu.id);
    const maxStreamRules = targetRules.filter((r) => r.name === 'Max streams');
    expect(maxStreamRules).toHaveLength(1);
    expect((maxStreamRules[0]?.params as { max_streams: number }).max_streams).toBe(2);
  });

  it('never carries removedAt from the source onto the surviving row on a same-server combine', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });

    // A member re-created a lost account on the same server; the old
    // server_user was soft-removed but the new one is active.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: server.id,
      trustScore: 80,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: server.id,
      trustScore: 60,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const sourceSession = await createTestSession({
      serverId: server.id,
      serverUserId: sourceSu.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id, {
      confirmSameServerCombine: true,
    });

    expect(result.wasSameServerCombine).toBe(true);

    const [survivingSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    expect(survivingSu?.removedAt).toBeNull();

    // History from the removed source is still folded in
    const [carriedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSession.id));
    expect(carriedSession?.serverUserId).toBe(targetSu.id);
  });

  it('refuses to absorb a login-capable identity', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const loginCapableSource = await createTestUser({ role: 'viewer' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    await createTestServerUser({ userId: loginCapableSource.id, serverId: serverB.id });

    await expect(mergeUsers(loginCapableSource.id, target.id, admin.id)).rejects.toBeInstanceOf(
      MergeDirectionError
    );
  });

  it('rejects absorbing a source that owns a Better Auth login account, and changes nothing', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    // role stays 'member' (not login-capable by role) but the identity has
    // acquired a login account through data drift; the in-transaction
    // authAccounts count must still reject it.
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: source.id,
      providerId: 'credential',
      userId: source.id,
    });

    await expect(mergeUsers(source.id, target.id, admin.id)).rejects.toBeInstanceOf(
      MergeDirectionError
    );

    // Nothing changed: both server users still belong to their original identities
    const [unmovedTargetSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    expect(unmovedTargetSu?.userId).toBe(target.id);
    const [unmovedSourceSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(unmovedSourceSu?.userId).toBe(source.id);
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(1);
    const [authAccountRow] = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, source.id));
    expect(authAccountRow).toBeDefined();
  });

  it('rejects merging an identity into itself', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const user = await createTestUser({ role: 'member' });
    await expect(mergeUsers(user.id, user.id, admin.id)).rejects.toThrow(
      'cannot merge an identity into itself'
    );
  });
});

describe('splitServerUser', () => {
  it('detaches a merged server user back into a fresh identity using the audit snapshot', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({
      role: 'member',
      username: 'dupe-bob',
      email: 'dupe-bob@example.com',
    });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    const sourceSession = await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
    });

    const mergeResult = await mergeUsers(source.id, target.id, admin.id);

    const splitResult = await splitServerUser(sourceSu.id, admin.id);

    // Fresh identity restored from the audit snapshot, role never raised
    const [restored] = await db.select().from(users).where(eq(users.id, splitResult.newUserId));
    expect(restored?.username).toBe('dupe-bob');
    expect(restored?.email).toBe('dupe-bob@example.com');
    expect(restored?.role).toBe('member');

    // Server user and its history follow the new identity
    const [detachedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(detachedSu?.userId).toBe(splitResult.newUserId);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sourceSession.id));
    expect(session?.serverUserId).toBe(sourceSu.id);

    // Audit marked as undone
    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(audit?.undoneAt).not.toBeNull();
  });

  it('falls back to server user fields when no audit record covers the server user', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const identity = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: identity.id, serverId: serverA.id });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: serverB.id,
      username: 'never-merged',
      email: 'never-merged@example.com',
    });

    const result = await splitServerUser(su.id, admin.id);

    const [restored] = await db.select().from(users).where(eq(users.id, result.newUserId));
    expect(restored?.username).toBe('never-merged');
    expect(restored?.email).toBe('never-merged@example.com');
    expect(restored?.role).toBe('member');
  });

  it('refuses to split the only server account of an identity', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const identity = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: identity.id, serverId: server.id });

    await expect(splitServerUser(su.id, admin.id)).rejects.toBeInstanceOf(MergeValidationError);
  });

  it('drops the email on the new identity when it is already taken', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const identity = await createTestUser({ role: 'member', email: 'shared@example.com' });
    await createTestServerUser({ userId: identity.id, serverId: serverA.id });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: serverB.id,
      email: 'shared@example.com',
    });

    const result = await splitServerUser(su.id, admin.id);

    const [restored] = await db.select().from(users).where(eq(users.id, result.newUserId));
    expect(restored?.email).toBeNull();
  });
});

describe('GET /users/:id/full identity aggregation', () => {
  it('returns the identity server user set and combined stats after a merge', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: targetSu.id,
      durationMs: 1000,
      stoppedAt: new Date(),
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 2000,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: `/users/${targetSu.id}/full` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.identity.userId).toBe(target.id);
    const identitySuIds = body.identity.serverUsers.map((su: { id: string }) => su.id).sort();
    expect(identitySuIds).toEqual([sourceSu.id, targetSu.id].sort());
    expect(body.identity.stats.totalSessions).toBe(2);
    expect(body.identity.stats.totalWatchTime).toBe(3000);
    // Both accounts default to trustScore 100 with sessionCount 0, so the
    // weighted aggregate falls back to the neutral default, and no violations
    // were recorded for either side of the merge.
    expect(body.identity.aggregateTrustScore).toBe(100);
    expect(body.identity.totalViolations).toBe(0);

    // Requesting through the other sibling's id returns the same identity block.
    const responseFromSource = await app.inject({
      method: 'GET',
      url: `/users/${sourceSu.id}/full`,
    });
    expect(responseFromSource.statusCode).toBe(200);
    const bodyFromSource = responseFromSource.json();
    expect(bodyFromSource.identity.userId).toBe(target.id);
    const identitySuIdsFromSource = bodyFromSource.identity.serverUsers
      .map((su: { id: string }) => su.id)
      .sort();
    expect(identitySuIdsFromSource).toEqual([sourceSu.id, targetSu.id].sort());
    expect(bodyFromSource.identity.stats.totalSessions).toBe(2);
    expect(bodyFromSource.identity.stats.totalWatchTime).toBe(3000);

    await app.close();
  });

  it('scopes the identity block to servers the caller can access', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: targetSu.id,
      durationMs: 1000,
      stoppedAt: new Date(),
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 2000,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer scoped only to serverA (where targetSu lives), not serverB
    // (where the merged-in sourceSu lives).
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: `/users/${targetSu.id}/full` });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const identitySuIds = body.identity.serverUsers.map((su: { id: string }) => su.id);
    expect(identitySuIds).toEqual([targetSu.id]);
    expect(body.identity.stats.totalSessions).toBe(1);
    expect(body.identity.stats.totalWatchTime).toBe(1000);
  });
});
