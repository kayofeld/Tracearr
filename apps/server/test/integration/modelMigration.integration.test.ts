/**
 * Automation model boot-migration integration tests
 *
 * Seeds the pre-phase-4 corpus — V1 rows with type/params, V2 rows carrying every legacy
 * action shape, inactivity/mixed/account-attribute/transcode/pause rules, and runs with and
 * without data.evidence — then runs the migration twice against a real database: the first
 * pass must produce exact triggers, node ids, rewritten actions, version rows and backfilled
 * run columns; the second must write nothing and log nothing.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- modelMigration
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import type {
  Action,
  AutomationActions,
  AutomationConditions,
  TriggerNode,
} from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { automations, automationRuns, automationVersions } from '../../src/db/schema.js';
import {
  runAutomationModelMigration,
  type StoredAction,
} from '../../src/services/automations/modelMigration.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const conditions = (...fields: Array<[string, string, unknown]>): AutomationConditions =>
  ({
    groups: fields.map(([field, operator, value]) => ({
      conditions: [{ field, operator, value }],
    })),
  }) as AutomationConditions;

async function insertV2(overrides: {
  name: string;
  conditions: AutomationConditions;
  actions?: { actions: StoredAction[] };
}) {
  const [row] = await db
    .insert(automations)
    .values({
      name: overrides.name,
      severity: 'warning',
      isActive: true,
      conditions: overrides.conditions,
      // Pre-phase-4 rows predate both the triggers default and the action contract.
      triggers: sql`NULL`,
      actions: (overrides.actions ?? { actions: [] }) as AutomationActions,
    })
    .returning();
  if (!row) throw new Error(`failed to insert ${overrides.name}`);
  return row;
}

/** The v1 columns left the schema; only the SQL migrations still carry them. */
async function insertV1(overrides: {
  name: string;
  type: 'concurrent_streams' | 'account_inactivity';
  params: Record<string, unknown>;
}): Promise<{ id: string }> {
  const result = await db.execute(sql`
    INSERT INTO automations (name, type, params, severity, is_active, triggers)
    VALUES (
      ${overrides.name}, ${overrides.type}, ${JSON.stringify(overrides.params)}::jsonb,
      'low', true, NULL
    )
    RETURNING id::text AS id
  `);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error(`failed to insert ${overrides.name}`);
  return { id };
}

const legacyColumnsOf = async (id: string) => {
  const result = await db.execute(sql`SELECT type, params FROM automations WHERE id = ${id}`);
  return result.rows[0];
};

async function insertRun(values: {
  automationId: string;
  serverUserId: string | null;
  sessionId: string | null;
  data: Record<string, unknown>;
  acknowledgedAt?: Date;
  dismissedAt?: Date;
}) {
  const [row] = await db
    .insert(automationRuns)
    .values({
      automationId: values.automationId,
      serverUserId: values.serverUserId,
      sessionId: values.sessionId,
      severity: 'warning',
      data: values.data,
      acknowledgedAt: values.acknowledgedAt ?? null,
      dismissedAt: values.dismissedAt ?? null,
    })
    .returning();
  if (!row) throw new Error('failed to insert run');
  return row;
}

/** The writer can never pair one session with two accounts; a hand-touched database can. */
async function insertRawRun(values: {
  automationId: string;
  serverUserId: string;
  sessionId: string;
  createdAt: string;
}) {
  const result = await db.execute(sql`
    INSERT INTO automation_runs (rule_id, server_user_id, session_id, severity, data, created_at)
    VALUES (
      ${values.automationId}, ${values.serverUserId}, ${values.sessionId},
      'warning', '{}'::jsonb, ${values.createdAt}
    )
    RETURNING id::text AS id
  `);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error('failed to insert raw run');
  return id;
}

const triggerTypes = (row: { triggers: TriggerNode[] | null }) =>
  (row.triggers ?? []).map((trigger) => trigger.type);

const load = async (id: string) => {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  if (!row) throw new Error(`automation ${id} vanished`);
  return row;
};

const loadRun = async (id: string) => {
  const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, id));
  if (!row) throw new Error(`run ${id} vanished`);
  return row;
};

async function seedCorpus() {
  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'plex' });
  const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
  const stranger = await createTestUser({ role: 'user' });
  const otherServerUser = await createTestServerUser({ userId: stranger.id, serverId: server.id });
  const sessions = await Promise.all([
    createTestSession({ serverId: server.id, serverUserId: serverUser.id }),
    createTestSession({ serverId: server.id, serverUserId: serverUser.id }),
    createTestSession({ serverId: server.id, serverUserId: serverUser.id }),
    createTestSession({ serverId: server.id, serverUserId: serverUser.id }),
    createTestSession({ serverId: server.id, serverUserId: serverUser.id }),
  ]);

  const v1Concurrent = await insertV1({
    name: 'v1 concurrent',
    type: 'concurrent_streams',
    params: { maxStreams: 2 },
  });
  const v1Inactivity = await insertV1({
    name: 'v1 inactivity',
    type: 'account_inactivity',
    params: { inactivityValue: 2, inactivityUnit: 'weeks' },
  });
  const everyAction = await insertV2({
    name: 'every action',
    conditions: conditions(['concurrent_streams', 'gt', 3]),
    actions: {
      actions: [
        { type: 'log_only', message: 'noted' },
        { type: 'adjust_trust', amount: -5 },
        { type: 'set_trust', value: 20 },
        { type: 'reset_trust' },
        {
          type: 'kill_stream',
          require_confirmation: true,
          delay_seconds: 10,
          message: 'stopping',
        },
        { type: 'send', to: [randomUUID()], cooldown_minutes: 15 },
        { type: 'message_client', message: 'slow down' },
      ],
    },
  });
  const inactiveOnly = await insertV2({
    name: 'inactive only',
    conditions: conditions(['inactive_days', 'gte', 30]),
  });
  const mixedInactive = await insertV2({
    name: 'mixed inactive',
    conditions: conditions(['inactive_days', 'gte', 30], ['current_pause_minutes', 'gt', 20]),
  });
  const accountAttribute = await insertV2({
    name: 'account attribute',
    conditions: conditions(['trust_score', 'lt', 50]),
  });
  const transcode = await insertV2({
    name: 'transcode',
    conditions: conditions(['is_transcoding', 'eq', true], ['output_resolution', 'eq', '1080p']),
  });
  const paused = await insertV2({
    name: 'paused',
    conditions: conditions(['total_pause_minutes', 'gt', 30]),
  });
  const inactiveTranscode = await insertV2({
    name: 'inactive transcode',
    conditions: conditions(['inactive_days', 'gte', 14], ['is_transcoding', 'eq', true]),
  });
  const noActions = await insertV2({
    name: 'no actions',
    conditions: conditions(['is_transcode_downgrade', 'eq', true]),
    actions: { actions: [] },
  });

  const evidence = { field: 'concurrent_streams', actual: 4, matched: true };
  const withEvidence = await insertRun({
    automationId: everyAction.id,
    serverUserId: serverUser.id,
    sessionId: sessions[0]?.id ?? null,
    data: { evidence, ruleName: 'every action' },
  });
  const withoutEvidence = await insertRun({
    automationId: everyAction.id,
    serverUserId: serverUser.id,
    sessionId: sessions[1]?.id ?? null,
    data: { ruleName: 'every action' },
    acknowledgedAt: new Date('2026-01-02T03:04:05Z'),
  });
  const dismissed = await insertRun({
    automationId: transcode.id,
    serverUserId: serverUser.id,
    sessionId: sessions[2]?.id ?? null,
    data: { evidence },
    dismissedAt: new Date('2026-01-03T03:04:05Z'),
  });
  const accountRun = await insertRun({
    automationId: inactiveOnly.id,
    serverUserId: serverUser.id,
    sessionId: null,
    data: { evidence: { field: 'inactive_days', actual: 45, matched: true } },
  });
  const subjectless = await insertRun({
    automationId: paused.id,
    serverUserId: null,
    sessionId: null,
    data: { ruleName: 'paused' },
  });
  const sharedSession = sessions[4]?.id;
  if (!sharedSession) throw new Error('missing session for the duplicate pair');
  const duplicateOlder = await insertRawRun({
    automationId: accountAttribute.id,
    serverUserId: serverUser.id,
    sessionId: sharedSession,
    createdAt: '2026-01-04T00:00:00Z',
  });
  const duplicateNewer = await insertRawRun({
    automationId: accountAttribute.id,
    serverUserId: otherServerUser.id,
    sessionId: sharedSession,
    createdAt: '2026-01-05T00:00:00Z',
  });

  return {
    serverUser,
    sharedSession,
    rules: {
      v1Concurrent,
      v1Inactivity,
      everyAction,
      inactiveOnly,
      mixedInactive,
      accountAttribute,
      transcode,
      paused,
      noActions,
      inactiveTranscode,
    },
    runs: {
      withEvidence,
      withoutEvidence,
      dismissed,
      accountRun,
      subjectless,
      duplicateOlder,
      duplicateNewer,
    },
    evidence,
  };
}

const snapshot = async () => {
  const rows = await db.execute(sql`
    SELECT 'automation' AS kind, id::text AS id, xmin::text AS version FROM automations
    UNION ALL
    SELECT 'run', id::text, xmin::text FROM automation_runs
    UNION ALL
    SELECT 'version', id::text, xmin::text FROM automation_versions
    ORDER BY 1, 2
  `);
  return rows.rows;
};

describe('runAutomationModelMigration', () => {
  it('gives the whole corpus triggers, node ids, rewritten actions, versions and backfilled runs', async () => {
    const seeded = await seedCorpus();

    await runAutomationModelMigration();

    const v1Concurrent = await load(seeded.rules.v1Concurrent.id);
    expect(await legacyColumnsOf(v1Concurrent.id)).toEqual({ type: null, params: null });
    expect(v1Concurrent.conditions?.groups[0]?.conditions[0]).toMatchObject({
      field: 'concurrent_streams',
      operator: 'gt',
      value: 2,
    });
    expect(triggerTypes(v1Concurrent)).toEqual(['session.started']);

    const v1Inactivity = await load(seeded.rules.v1Inactivity.id);
    expect(v1Inactivity.conditions?.groups[0]?.conditions[0]).toMatchObject({
      field: 'inactive_days',
      operator: 'gte',
      value: 14,
    });
    expect(triggerTypes(v1Inactivity)).toEqual(['account.inactive_for']);

    expect(triggerTypes(await load(seeded.rules.inactiveOnly.id))).toEqual([
      'account.inactive_for',
    ]);
    expect(triggerTypes(await load(seeded.rules.mixedInactive.id))).toEqual([
      'session.paused',
      'session.held_for',
      'account.inactive_for',
    ]);
    expect(triggerTypes(await load(seeded.rules.accountAttribute.id))).toEqual(['session.started']);
    expect(triggerTypes(await load(seeded.rules.transcode.id))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
    expect(triggerTypes(await load(seeded.rules.paused.id))).toEqual([
      'session.started',
      'session.paused',
      'session.held_for',
    ]);
    expect(triggerTypes(await load(seeded.rules.noActions.id))).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
    expect(triggerTypes(await load(seeded.rules.inactiveTranscode.id))).toEqual([
      'session.transcode_changed',
      'account.inactive_for',
    ]);

    const everyAction = await load(seeded.rules.everyAction.id);
    const actions = (everyAction.actions?.actions ?? []) as Array<
      Action & { id: string; enabled: boolean }
    >;
    expect(actions.map((action) => action.type)).toEqual([
      'trust',
      'trust',
      'trust',
      'kill_stream',
      'send',
      'message_client',
    ]);
    expect(actions[0]).toMatchObject({ mode: 'adjust', amount: -5 });
    expect(actions[1]).toMatchObject({ mode: 'set', value: 20 });
    expect(actions[2]).toMatchObject({ mode: 'reset' });
    expect(actions[3]).not.toHaveProperty('require_confirmation');
    expect(actions[3]).toMatchObject({ delay_seconds: 10, message: 'stopping' });
    expect(actions[4]).toMatchObject({ cooldown_minutes: 15 });
    for (const action of actions) {
      expect(action.id).toMatch(UUID);
      expect(action.enabled).toBe(true);
    }

    const conditionNodes = (everyAction.conditions?.groups ?? []).flatMap(
      (group) => group.conditions
    ) as unknown as Array<{ id: string; enabled: boolean; field: string }>;
    expect(conditionNodes).toHaveLength(1);
    expect(conditionNodes[0]?.id).toMatch(UUID);
    expect(conditionNodes[0]?.enabled).toBe(true);
    expect(conditionNodes[0]?.field).toBe('concurrent_streams');

    const noActions = await load(seeded.rules.noActions.id);
    expect(noActions.actions).toEqual({ actions: [] });

    const versions = await db.select().from(automationVersions);
    expect(versions).toHaveLength(Object.keys(seeded.rules).length);
    expect(versions.every((version) => version.version === 1)).toBe(true);
    const everyActionVersion = versions.find(
      (version) => version.automationId === seeded.rules.everyAction.id
    );
    expect(everyActionVersion?.definition).toEqual({
      name: 'every action',
      kind: 'policy',
      severity: 'warning',
      triggers: everyAction.triggers,
      conditions: everyAction.conditions,
      actions: everyAction.actions,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
    });

    const withEvidence = await loadRun(seeded.runs.withEvidence.id);
    expect(withEvidence.subjectKey).toBe(seeded.runs.withEvidence.sessionId);
    expect(withEvidence.startedAt?.toISOString()).toBe(withEvidence.createdAt.toISOString());
    expect(withEvidence.finishedAt?.toISOString()).toBe(withEvidence.createdAt.toISOString());
    expect(withEvidence.steps).toEqual([{ step: 'evidence', data: seeded.evidence }]);
    expect(withEvidence.definitionVersionId).toBe(everyActionVersion?.id);

    const withoutEvidence = await loadRun(seeded.runs.withoutEvidence.id);
    expect(withoutEvidence.steps).toBeNull();
    expect(withoutEvidence.subjectKey).toBe(seeded.runs.withoutEvidence.sessionId);
    expect(withoutEvidence.acknowledgedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');

    const dismissed = await loadRun(seeded.runs.dismissed.id);
    expect(dismissed.subjectKey).toBe(seeded.runs.dismissed.sessionId);
    expect(dismissed.dismissedAt?.toISOString()).toBe('2026-01-03T03:04:05.000Z');
    expect(dismissed.steps).toEqual([{ step: 'evidence', data: seeded.evidence }]);

    const accountRun = await loadRun(seeded.runs.accountRun.id);
    expect(accountRun.subjectKey).toBe(seeded.serverUser.id);
    expect(accountRun.definitionVersionId).toBe(
      versions.find((version) => version.automationId === seeded.rules.inactiveOnly.id)?.id
    );

    const subjectless = await loadRun(seeded.runs.subjectless.id);
    expect(subjectless.subjectKey).toBeNull();
    expect(subjectless.startedAt?.toISOString()).toBe(subjectless.createdAt.toISOString());

    const older = await loadRun(seeded.runs.duplicateOlder);
    const newer = await loadRun(seeded.runs.duplicateNewer);
    expect(older.acknowledgedAt).not.toBeNull();
    expect(newer.acknowledgedAt).toBeNull();
    expect(older.subjectKey).toBe(seeded.sharedSession);
    expect(newer.subjectKey).toBe(seeded.sharedSession);
  });

  it('leaves a run recorded after version 1 unlinked when it runs again', async () => {
    const seeded = await seedCorpus();
    await runAutomationModelMigration();

    // No subject key, so the second pass has work to do and reaches the version backfill.
    const later = await insertRun({
      automationId: seeded.rules.paused.id,
      serverUserId: seeded.serverUser.id,
      sessionId: null,
      data: { ruleName: 'paused' },
    });

    await runAutomationModelMigration();

    const reloaded = await loadRun(later.id);
    expect(reloaded.subjectKey).toBe(seeded.serverUser.id);
    expect(reloaded.definitionVersionId).toBeNull();
  });

  it('writes nothing and logs nothing on a second pass', async () => {
    await seedCorpus();
    await runAutomationModelMigration();

    const before = await snapshot();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await runAutomationModelMigration();

    const lines = infoSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[automation-migration]')
    );
    infoSpy.mockRestore();

    expect(lines).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
