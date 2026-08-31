import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, AutomationActions, AutomationConditions } from '@tracearr/shared';
import type { StoredAction } from '../automations/modelMigration.js';

const infos: string[] = [];
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: (msg: string) => infos.push(msg),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../db/client.js', () => ({ db: { transaction: vi.fn(), execute: vi.fn() } }));
vi.mock('../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('../../jobs/poller/database.js', () => ({ invalidateAutomationsCache: vi.fn() }));
vi.mock('../automations/v2Integration.js', () => ({ convertV1Rule: vi.fn() }));

import { db } from '../../db/client.js';
import { automations, automationVersions } from '../../db/schema.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import { runAutomationModelMigration } from '../automations/modelMigration.js';
import { convertV1Rule } from '../automations/v2Integration.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in c) {
        const v = c.value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return String(c);
    })
    .join('');
}

/** The raw shape `selectLegacyRows` reads back, straight from the dropped columns. */
interface LegacyRow {
  id: unknown;
  name: unknown;
  type: unknown;
  params: Record<string, unknown> | null;
  server_user_id: string | null;
  server_id: string | null;
  is_active: boolean;
}

interface UntriggeredRow {
  id: string;
  conditions: AutomationConditions | null;
  actions: { actions: StoredAction[] } | null;
}

interface VersionlessRow {
  id: string;
  name: string;
  kind: string;
  severity: string;
  triggers: unknown;
  conditions: AutomationConditions | null;
  actions: AutomationActions | null;
  serverId: string | null;
  serverUserId: string | null;
  userId: string | null;
  enforceAcrossServers: boolean;
}

interface Counts {
  legacy: number;
  missing_triggers: number;
  missing_version: number;
  stale_runs: number;
}

interface TxState {
  counts: Counts;
  txCounts?: Counts;
  /** Defaults to whether the state supplies legacy rows at all. */
  legacyColumns?: boolean;
  legacyRows?: LegacyRow[];
  untriggeredRows?: UntriggeredRow[];
  versionlessRows?: VersionlessRow[];
  rowCounts?: Record<string, number>;
}

function buildTx(state: TxState) {
  const log: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];

  const countRows = (counts: TxState['counts']) => ({ rows: [counts] });
  const legacyColumns = state.legacyColumns ?? state.legacyRows !== undefined;

  const tx = {
    execute: vi.fn((query: unknown) => {
      const text = sqlText(query);
      if (text.includes('pg_advisory_xact_lock')) {
        log.push('lock');
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('missing_triggers')) {
        log.push('count');
        return Promise.resolve(countRows(state.txCounts ?? state.counts));
      }
      if (text.includes('server_user_id, server_id, is_active')) {
        log.push('select:legacy');
        return Promise.resolve({ rows: state.legacyRows ?? [] });
      }
      const marker = text.trim().split(/\s+/).slice(0, 6).join(' ');
      log.push(`execute:${marker}`);
      const key = Object.keys(state.rowCounts ?? {}).find((k) => text.includes(k));
      return Promise.resolve({ rows: [], rowCount: key ? (state.rowCounts?.[key] ?? 0) : 0 });
    }),
    select: vi.fn((projection: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === automationVersions) return { where: () => ({ subquery: true }) };
        const which = Object.keys(projection).includes('kind') ? 'versionless' : 'untriggered';
        log.push(`select:${which}`);
        const rows =
          which === 'versionless' ? (state.versionlessRows ?? []) : (state.untriggeredRows ?? []);
        return { where: () => Promise.resolve(rows) };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        log.push(table === automations ? 'update:automations' : 'update:other');
        updates.push(patch);
        return { where: () => Promise.resolve(undefined) };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Array<Record<string, unknown>>) => {
        log.push(table === automationVersions ? 'insert:versions' : 'insert:other');
        inserted.push(...values);
        return Promise.resolve(undefined);
      },
    })),
  };

  return { tx, log, updates, inserted, legacyColumns };
}

/** The boot probe and the pre-transaction count both land on `db.execute`. */
function mockDbExecute(state: TxState, legacyColumns: boolean) {
  vi.mocked(db.execute).mockImplementation(((query: unknown) => {
    if (sqlText(query).includes('information_schema')) {
      return Promise.resolve({ rows: [{ present: legacyColumns ? 2 : 0 }] });
    }
    return Promise.resolve({ rows: [state.counts] });
  }) as never);
}

async function run(state: TxState) {
  const harness = buildTx(state);
  mockDbExecute(state, harness.legacyColumns);
  vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
    cb(harness.tx)) as unknown as typeof db.transaction);
  await runAutomationModelMigration();
  return harness;
}

const idle: Counts = { legacy: 0, missing_triggers: 0, missing_version: 0, stale_runs: 0 };

const conditionsWith = (field: string): AutomationConditions =>
  ({ groups: [{ conditions: [{ field, operator: 'gt', value: 1 }] }] }) as AutomationConditions;

const actionsOf = (...actions: StoredAction[]): { actions: StoredAction[] } => ({ actions });

describe('runAutomationModelMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infos.length = 0;
  });

  it('never opens a transaction when nothing qualifies', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [idle] } as never);
    await runAutomationModelMigration();

    expect(db.transaction).not.toHaveBeenCalled();
    expect(invalidateAutomationsCache).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
  });

  it('takes the lock before reading and writes nothing when another boot won the race', async () => {
    const harness = await run({
      counts: { ...idle, missing_triggers: 1, missing_version: 1 },
      txCounts: idle,
    });

    expect(harness.log).toEqual(['lock', 'count']);
    expect(harness.updates).toEqual([]);
    expect(harness.inserted).toEqual([]);
    expect(invalidateAutomationsCache).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
  });

  it('converts V1 rows before synthesizing triggers from their new conditions', async () => {
    const legacyRow: LegacyRow = {
      id: 'a1',
      name: 'inactive folks',
      type: 'account_inactivity',
      params: { inactivityValue: 30, inactivityUnit: 'days' },
      server_user_id: null,
      server_id: null,
      is_active: true,
    };
    const harness = await run({
      counts: { ...idle, legacy: 1, missing_triggers: 1, missing_version: 1 },
      legacyRows: [legacyRow],
      untriggeredRows: [
        { id: 'a1', conditions: conditionsWith('inactive_days'), actions: actionsOf() },
      ],
      versionlessRows: [],
    });

    expect(vi.mocked(convertV1Rule).mock.calls[0]?.[0]).toBe(harness.tx);
    expect(vi.mocked(convertV1Rule).mock.calls[0]?.[1]).toEqual({
      id: 'a1',
      name: 'inactive folks',
      type: 'account_inactivity',
      params: { inactivityValue: 30, inactivityUnit: 'days' },
      serverUserId: null,
      serverId: null,
      isActive: true,
    });
    expect(harness.log.slice(0, 5)).toEqual([
      'lock',
      'count',
      'select:legacy',
      'select:untriggered',
      'update:automations',
    ]);

    const triggers = harness.updates[0]?.triggers as Array<{ type: string; enabled: boolean }>;
    expect(triggers.map((t) => t.type)).toEqual(['account.inactive_for']);
    expect(harness.updates[0]?.actions).toEqual({ actions: [] });
  });

  it('skips the V1 pass and its count when the dropped columns are gone', async () => {
    const harness = await run({
      counts: { ...idle, missing_triggers: 1 },
      legacyColumns: false,
      untriggeredRows: [
        { id: 'a1', conditions: conditionsWith('inactive_days'), actions: actionsOf() },
      ],
    });

    expect(harness.log).not.toContain('select:legacy');
    expect(convertV1Rule).not.toHaveBeenCalled();
    const counted = harness.tx.execute.mock.calls
      .map((call) => sqlText(call[0]))
      .find((text) => text.includes('missing_triggers'));
    expect(counted).not.toContain('a.type IS NOT NULL');
  });

  it('rewrites every legacy action shape and gives each surviving node an id', async () => {
    const harness = await run({
      counts: { ...idle, missing_triggers: 1 },
      untriggeredRows: [
        {
          id: 'a2',
          conditions: conditionsWith('total_pause_minutes'),
          actions: actionsOf(
            { type: 'log_only', message: 'noted' },
            { type: 'adjust_trust', amount: -10 },
            { type: 'set_trust', value: 30 },
            { type: 'reset_trust' },
            { type: 'kill_stream', require_confirmation: true, message: 'stop', delay_seconds: 5 },
            { type: 'send', to: ['dest-1'], cooldown_minutes: 15 },
            { type: 'message_client', message: 'hello' }
          ),
        },
      ],
      versionlessRows: [],
    });

    const actions = (harness.updates[0]?.actions as AutomationActions).actions as Array<
      Action & { id: string; enabled: boolean }
    >;
    expect(actions.map((a) => a.type)).toEqual([
      'trust',
      'trust',
      'trust',
      'kill_stream',
      'send',
      'message_client',
    ]);
    expect(actions[0]).toMatchObject({ type: 'trust', mode: 'adjust', amount: -10 });
    expect(actions[1]).toMatchObject({ type: 'trust', mode: 'set', value: 30 });
    expect(actions[2]).toMatchObject({ type: 'trust', mode: 'reset' });
    expect(actions[3]).toEqual({
      type: 'kill_stream',
      message: 'stop',
      delay_seconds: 5,
      id: expect.stringMatching(UUID),
      enabled: true,
    });
    expect(actions[5]).toMatchObject({ type: 'message_client', message: 'hello' });
    for (const action of actions) {
      expect(action.id).toMatch(UUID);
      expect(action.enabled).toBe(true);
    }
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it('keeps a cooldown a legacy trust row carried', async () => {
    const trusted: StoredAction = { type: 'adjust_trust', amount: 5, cooldown_minutes: 60 };
    const harness = await run({
      counts: { ...idle, missing_triggers: 1 },
      untriggeredRows: [{ id: 'a3', conditions: null, actions: actionsOf(trusted) }],
      versionlessRows: [],
    });

    expect((harness.updates[0]?.actions as AutomationActions).actions[0]).toMatchObject({
      type: 'trust',
      mode: 'adjust',
      amount: 5,
      cooldown_minutes: 60,
    });
  });

  it('keeps an automation whose only action was log_only', async () => {
    const harness = await run({
      counts: { ...idle, missing_triggers: 1 },
      untriggeredRows: [
        {
          id: 'a4',
          conditions: conditionsWith('is_transcoding'),
          actions: actionsOf({ type: 'log_only' }),
        },
      ],
      versionlessRows: [],
    });

    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]?.actions).toEqual({ actions: [] });
    expect((harness.updates[0]?.triggers as Array<{ type: string }>).map((t) => t.type)).toEqual([
      'session.started',
      'session.transcode_changed',
    ]);
  });

  it('stamps an id and an enabled flag on every condition node', async () => {
    const harness = await run({
      counts: { ...idle, missing_triggers: 1 },
      untriggeredRows: [
        {
          id: 'a5',
          conditions: {
            groups: [
              { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }] },
              { conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] },
            ],
          },
          actions: null,
        },
      ],
      versionlessRows: [],
    });

    const conditions = harness.updates[0]?.conditions as AutomationConditions;
    const nodes = conditions.groups.flatMap((g) => g.conditions) as unknown as Array<{
      id: string;
      enabled: boolean;
      field: string;
    }>;
    expect(nodes.map((n) => n.field)).toEqual(['concurrent_streams', 'trust_score']);
    for (const node of nodes) {
      expect(node.id).toMatch(UUID);
      expect(node.enabled).toBe(true);
    }
  });

  it('seeds one version row per version-less automation from the reshaped definition', async () => {
    const harness = await run({
      counts: { ...idle, missing_version: 1 },
      versionlessRows: [
        {
          id: 'a6',
          name: 'no more pausing',
          kind: 'policy',
          severity: 'high',
          triggers: [{ id: 't1', type: 'session.paused', enabled: true }],
          conditions: conditionsWith('current_pause_minutes'),
          actions: { actions: [{ type: 'trust', mode: 'reset' }] },
          serverId: 'srv-1',
          serverUserId: null,
          userId: null,
          enforceAcrossServers: true,
        },
      ],
    });

    expect(harness.inserted).toEqual([
      {
        automationId: 'a6',
        version: 1,
        definition: {
          name: 'no more pausing',
          kind: 'policy',
          severity: 'high',
          triggers: [{ id: 't1', type: 'session.paused', enabled: true }],
          conditions: conditionsWith('current_pause_minutes'),
          actions: { actions: [{ type: 'trust', mode: 'reset' }] },
          serverId: 'srv-1',
          serverUserId: null,
          userId: null,
          enforceAcrossServers: true,
        },
      },
    ]);
  });

  it('backfills the run columns in plain SQL and reports what it touched', async () => {
    const harness = await run({
      counts: { ...idle, missing_version: 1 },
      versionlessRows: [
        {
          id: 'a7',
          name: 'r',
          kind: 'policy',
          severity: 'warning',
          triggers: null,
          conditions: null,
          actions: null,
          serverId: null,
          serverUserId: null,
          userId: null,
          enforceAcrossServers: false,
        },
      ],
      rowCounts: {
        row_number: 0,
        definition_version_id: 4,
        subject_key: 6,
        started_at: 6,
        finished_at: 5,
        steps: 3,
      },
    });

    expect(harness.log.filter((l) => l.startsWith('execute:'))).toEqual([
      'execute:UPDATE automation_runs AS r SET definition_version_id',
      'execute:UPDATE automation_runs SET acknowledged_at = now()',
      'execute:UPDATE automation_runs SET subject_key = COALESCE(session_id::text,',
      'execute:UPDATE automation_runs SET started_at = created_at',
      'execute:UPDATE automation_runs SET finished_at = created_at',
      "execute:UPDATE automation_runs SET steps = jsonb_build_array(jsonb_build_object('step',",
    ]);
    expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('6 subject key(s)');
    expect(infos[0]).toContain('4 version link(s)');
    expect(infos[0]).toContain('11 timestamp(s)');
    expect(infos[0]).toContain('3 step log(s)');
  });

  it('links only the runs that predate version 1', async () => {
    const harness = await run({
      counts: { ...idle, stale_runs: 1 },
      rowCounts: { row_number: 0, subject_key: 1 },
    });

    const link = harness.tx.execute.mock.calls
      .map((call) => sqlText(call[0]))
      .find((text) => text.includes('SET definition_version_id'));

    expect(link).toContain('r.definition_version_id IS NULL');
    expect(link).toContain('r.created_at <= v.created_at');
  });

  it('runs for a run row a rolling upgrade left without a subject key', async () => {
    const harness = await run({
      counts: { ...idle, stale_runs: 1 },
      rowCounts: { row_number: 0, subject_key: 2 },
    });

    expect(harness.updates).toEqual([]);
    expect(harness.inserted).toEqual([]);
    expect(harness.log).toContain(
      'execute:UPDATE automation_runs SET subject_key = COALESCE(session_id::text,'
    );
    expect(infos[0]).toContain('2 subject key(s)');
  });

  it('acknowledges duplicate active runs before the subject key backfill', async () => {
    const harness = await run({
      counts: { ...idle, stale_runs: 1 },
      rowCounts: { row_number: 2, subject_key: 5 },
    });

    const executed = harness.log.filter((l) => l.startsWith('execute:'));
    expect(executed.slice(0, 3)).toEqual([
      'execute:UPDATE automation_runs AS r SET definition_version_id',
      'execute:UPDATE automation_runs SET acknowledged_at = now()',
      'execute:UPDATE automation_runs SET subject_key = COALESCE(session_id::text,',
    ]);
    expect(infos[0]).toContain('Acknowledged 2 duplicate active run(s)');
  });

  it('refuses to read a legacy row whose type it does not recognize', async () => {
    const state: TxState = {
      counts: { ...idle, legacy: 1 },
      legacyRows: [
        {
          id: 'a9',
          name: 'from the future',
          type: 'quantum_streams',
          params: null,
          server_user_id: null,
          server_id: null,
          is_active: true,
        },
      ],
    };

    await expect(run(state)).rejects.toThrow('Cannot read legacy automation a9');
    expect(convertV1Rule).not.toHaveBeenCalled();
  });

  it('reads a params array as no params at all', async () => {
    await run({
      counts: { ...idle, legacy: 1 },
      legacyRows: [
        {
          id: 'a10',
          name: 'array params',
          type: 'concurrent_streams',
          params: [{ maxStreams: 2 }] as unknown as Record<string, unknown>,
          server_user_id: null,
          server_id: null,
          is_active: true,
        },
      ],
    });

    expect(vi.mocked(convertV1Rule).mock.calls[0]?.[1]).toMatchObject({ id: 'a10', params: null });
  });

  it('lets a failed conversion abort the transaction without touching the cache', async () => {
    vi.mocked(convertV1Rule).mockRejectedValueOnce(new Error('unknown V1 type'));
    const harness = buildTx({
      counts: { ...idle, legacy: 1, missing_triggers: 1, missing_version: 1 },
      legacyRows: [
        {
          id: 'a8',
          name: 'broken',
          type: 'geo_restriction',
          params: null,
          server_user_id: null,
          server_id: null,
          is_active: true,
        },
      ],
    });
    mockDbExecute(
      { counts: { ...idle, legacy: 1, missing_triggers: 1, missing_version: 1 } },
      harness.legacyColumns
    );
    vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
      cb(harness.tx)) as unknown as typeof db.transaction);

    await expect(runAutomationModelMigration()).rejects.toThrow('unknown V1 type');
    expect(harness.updates).toEqual([]);
    expect(invalidateAutomationsCache).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
  });
});
