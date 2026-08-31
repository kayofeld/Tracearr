/**
 * Notification edge gate integration test
 *
 * The gate compares `data->>'edgeKey'` with IS NOT DISTINCT FROM, so a null edge has to
 * match a null bind against a real jsonb column — the one part of the gate a mocked
 * driver cannot answer.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- runRecorderGate
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import type { EngineAutomation, TriggerNode } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { automations, automationRuns } from '../../src/db/schema.js';
import { recordRun, type RunTrigger } from '../../src/services/automations/runRecorder.js';
import { carryTriggerIds } from '../../src/services/automations/triggers.js';
import type { EvaluationResult } from '../../src/services/automations/types.js';

const matched: EvaluationResult = {
  ruleId: 'unused',
  ruleName: 'notify on start',
  matched: true,
  matchedGroups: [0],
  actions: [],
  evidence: [],
};

describe('recordRun notification gate', () => {
  it('blocks a replayed null edge and lets a different edge through', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
    const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });

    const nodeId = randomUUID();
    const [row] = await db
      .insert(automations)
      .values({
        name: 'notify on start',
        kind: 'notification',
        severity: 'warning',
        isActive: true,
        conditions: { groups: [] },
        actions: { actions: [] },
        triggers: [{ id: nodeId, type: 'session.started', enabled: true }],
      })
      .returning();
    if (!row) throw new Error('failed to insert the automation');

    const automation: EngineAutomation = {
      id: row.id,
      name: row.name,
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      isActive: true,
      severity: 'warning',
      kind: 'notification',
      conditions: { groups: [] },
      actions: { actions: [] },
      triggers: [{ id: nodeId, type: 'session.started', enabled: true }],
      cooldownMinutes: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const record = (trigger: RunTrigger) =>
      recordRun({
        automation,
        result: matched,
        serverUserId: serverUser.id,
        serverId: server.id,
        scope: { kind: 'session', sessionId: session.id },
        session: null,
        trigger,
      });
    const nullEdge: RunTrigger = {
      type: 'session.started',
      nodeId,
      edgeKey: null,
      at: new Date(),
    };

    const first = await record(nullEdge);
    const replay = await record(nullEdge);
    const other = await record({ ...nullEdge, edgeKey: 'transcode/none' });

    expect(first).not.toBeNull();
    expect(replay).toBeNull();
    expect(other).not.toBeNull();

    const stored = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, row.id));
    expect(stored).toHaveLength(2);
  });

  it('re-fires on a re-minted trigger node and stays quiet on the one a save carried over', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
    const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });

    const conditions = {
      groups: [
        {
          conditions: [{ field: 'is_transcoding' as const, operator: 'eq' as const, value: true }],
        },
      ],
    };
    const stored: TriggerNode[] = [
      { id: randomUUID(), type: 'session.transcode_changed', enabled: true },
    ];
    const [row] = await db
      .insert(automations)
      .values({
        name: 'notify on transcode',
        kind: 'notification',
        severity: 'warning',
        isActive: true,
        conditions,
        actions: { actions: [] },
        triggers: stored,
      })
      .returning();
    if (!row) throw new Error('failed to insert the automation');

    const automation: EngineAutomation = {
      id: row.id,
      name: row.name,
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      isActive: true,
      severity: 'warning',
      kind: 'notification',
      conditions,
      actions: { actions: [] },
      triggers: stored,
      cooldownMinutes: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const record = (nodeId: string | null) =>
      recordRun({
        automation,
        result: matched,
        serverUserId: serverUser.id,
        serverId: server.id,
        scope: { kind: 'session', sessionId: session.id },
        session: null,
        trigger: {
          type: 'session.transcode_changed',
          nodeId,
          edgeKey: 'transcode/none',
          at: new Date(),
        },
      });

    const priorId = stored[0]?.id ?? null;
    const first = await record(priorId);
    // A template rebind rebuilds the set but keeps the id of every type that survived it.
    const afterSave = carryTriggerIds(
      [{ id: randomUUID(), type: 'session.transcode_changed', enabled: true }],
      stored
    );
    const carriedId =
      afterSave.find((trigger) => trigger.type === 'session.transcode_changed')?.id ?? null;
    const carried = await record(carriedId);
    const reminted = await record(randomUUID());

    expect(carriedId).toBe(priorId);

    expect(first).not.toBeNull();
    expect(carried).toBeNull();
    expect(reminted).not.toBeNull();
  });
});

describe('the account triggers against the real gate', () => {
  /** One stored notification automation carrying the node the trigger fires through. */
  async function seed(node: TriggerNode) {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
    const [row] = await db
      .insert(automations)
      .values({
        name: 'account watch',
        kind: 'notification',
        severity: 'warning',
        isActive: true,
        conditions: { groups: [] },
        actions: { actions: [] },
        triggers: [node],
      })
      .returning();
    if (!row) throw new Error('failed to insert the automation');
    const automation: EngineAutomation = {
      id: row.id,
      name: row.name,
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      isActive: true,
      severity: 'warning',
      kind: 'notification',
      conditions: { groups: [] },
      actions: { actions: [] },
      triggers: [node],
      cooldownMinutes: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return { automation, server, serverUser, automationId: row.id };
  }

  const storedRuns = async (automationId: string) =>
    (
      await db
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, automationId))
    ).length;

  it('records one new-device run per session, however often the session is announced', async () => {
    const nodeId = randomUUID();
    const { automation, server, serverUser, automationId } = await seed({
      id: nodeId,
      type: 'account.new_device',
      enabled: true,
    });
    const session = await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
    });

    const record = () =>
      recordRun({
        automation,
        result: matched,
        serverUserId: serverUser.id,
        serverId: server.id,
        scope: { kind: 'session', sessionId: session.id },
        session: null,
        // A first-seen device carries no edge: the session is the whole subject.
        trigger: { type: 'account.new_device', nodeId, edgeKey: null, at: new Date() },
      });

    expect(await record()).not.toBeNull();
    expect(await record()).toBeNull();
    expect(await storedRuns(automationId)).toBe(1);
  });

  it('lets each trust transition through and blocks a repeat of the same one', async () => {
    const nodeId = randomUUID();
    const { automation, server, serverUser, automationId } = await seed({
      id: nodeId,
      type: 'account.trust_changed',
      enabled: true,
    });

    const record = (edgeKey: string) =>
      recordRun({
        automation,
        result: matched,
        serverUserId: serverUser.id,
        serverId: server.id,
        scope: { kind: 'account', serverUserId: serverUser.id },
        session: null,
        trigger: { type: 'account.trust_changed', nodeId, edgeKey, at: new Date() },
      });

    expect(await record('90->85')).not.toBeNull();
    expect(await record('85->80')).not.toBeNull();
    // The same transition inside one subject is the replay the gate exists for.
    expect(await record('85->80')).toBeNull();
    expect(await storedRuns(automationId)).toBe(2);
  });
});
