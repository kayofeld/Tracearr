/**
 * Concurrent session-start recording
 *
 * The session insert path runs SERIALIZABLE, and a run insert lands inside it.
 * Anything that reads automation_runs in that transaction takes a relation-level
 * predicate lock, which every concurrent run insert pivots against - both
 * transactions then abort, and past the retry budget the session insert is lost.
 * Only a real database takes those locks, so this lives here.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- runRecorderConcurrency
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import type { EngineAutomation } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { automations, automationRuns, users } from '../../src/db/schema.js';
import { recordRun } from '../../src/services/automations/runRecorder.js';
import type { EvaluationResult } from '../../src/services/automations/types.js';

const matched: EvaluationResult = {
  ruleId: 'unused',
  ruleName: 'two streams is one too many',
  matched: true,
  matchedGroups: [0],
  actions: [],
  evidence: [],
};

async function seedPolicyAutomation(): Promise<EngineAutomation> {
  const nodeId = randomUUID();
  const [row] = await db
    .insert(automations)
    .values({
      name: 'two streams is one too many',
      kind: 'policy',
      severity: 'warning',
      isActive: true,
      conditions: { groups: [] },
      actions: { actions: [] },
      triggers: [{ id: nodeId, type: 'session.started', enabled: true }],
    })
    .returning();
  if (!row) throw new Error('failed to insert the automation');

  return {
    id: row.id,
    name: row.name,
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    kind: 'policy',
    conditions: { groups: [] },
    actions: { actions: [] },
    triggers: [{ id: nodeId, type: 'session.started', enabled: true }],
    cooldownMinutes: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Releases once every party has arrived, so both transactions are open at the same time. */
function meetingPoint(parties: number): () => Promise<void> {
  let arrived = 0;
  let release = (): void => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await open;
  };
}

describe('concurrent session starts', () => {
  it('records both runs without a serialization conflict', async () => {
    const automation = await seedPolicyAutomation();
    const server = await createTestServer({ type: 'plex' });
    // Separate identities, so the only thing the two transactions share is automation_runs.
    const starters = await Promise.all(
      [0, 1].map(async () => {
        const owner = await createTestUser({ role: 'owner' });
        const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
        const session = await createTestSession({
          serverId: server.id,
          serverUserId: serverUser.id,
        });
        return { serverUserId: serverUser.id, sessionId: session.id };
      })
    );
    const bothOpen = meetingPoint(starters.length);
    const effects: Array<() => Promise<void>> = [];

    const start = (serverUserId: string, sessionId: string) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const run = await recordRun({
          automation,
          result: matched,
          serverUserId,
          serverId: server.id,
          scope: { kind: 'session', sessionId, fresh: true },
          session: null,
          trigger: { type: 'session.started', nodeId: null, edgeKey: null, at: new Date() },
          tx,
          defer: (effect) => effects.push(effect),
        });
        // Neither commits until both have written, which is what makes them pivot.
        await bothOpen();
        return run;
      });

    const runs = await Promise.all(
      starters.map((starter) => start(starter.serverUserId, starter.sessionId))
    );

    expect(runs.every((run) => run !== null)).toBe(true);
    const stored = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automation.id));
    expect(stored).toHaveLength(2);
  });

  it('counts both runs once the post-commit phase drains', async () => {
    const automation = await seedPolicyAutomation();
    const server = await createTestServer({ type: 'plex' });
    const owner = await createTestUser({ role: 'owner' });
    const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
    const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });

    const effects: Array<() => Promise<void>> = [];
    await db.transaction(async (tx) => {
      await recordRun({
        automation,
        result: matched,
        serverUserId: serverUser.id,
        serverId: server.id,
        scope: { kind: 'session', sessionId: session.id, fresh: true },
        session: null,
        trigger: { type: 'session.started', nodeId: null, edgeKey: null, at: new Date() },
        tx,
        defer: (effect) => effects.push(effect),
      });
    });

    const beforeDrain = await totalViolationsOf(owner.id);
    for (const effect of effects) await effect();

    expect(beforeDrain).toBe(0);
    expect(await totalViolationsOf(owner.id)).toBe(1);
  });
});

async function totalViolationsOf(userId: string): Promise<number | null> {
  const rows = await db
    .select({ total: users.totalViolations })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]?.total ?? null;
}
