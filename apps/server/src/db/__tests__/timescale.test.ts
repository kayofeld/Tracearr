import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../client.js';
import {
  withSessionsCompressionPaused,
  initTimescaleDB,
  AGGREGATE_SCHEMA_VERSION,
} from '../timescale.js';

function executeMock() {
  return vi.mocked(db.execute) as unknown as ReturnType<typeof vi.fn>;
}

function executedSql(call: unknown[]): string {
  const arg = call[0] as {
    strings?: TemplateStringsArray;
    queryChunks?: Array<{ value?: string }>;
  };
  if (arg?.strings) return arg.strings.join('');
  if (arg?.queryChunks) return arg.queryChunks.map((c) => c.value ?? '').join('');
  return String(arg);
}

describe('withSessionsCompressionPaused', () => {
  beforeEach(() => {
    executeMock().mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the policy before the callback and restores it after', async () => {
    const order: string[] = [];
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('remove_compression_policy')) order.push('remove');
      if (sql.includes('add_compression_policy')) order.push('add');
      return Promise.resolve({ rows: [] }) as never;
    });

    const result = await withSessionsCompressionPaused(async () => {
      order.push('callback');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(order).toEqual(['remove', 'callback', 'add']);
  });

  it('restores the policy even when the callback throws', async () => {
    const calls: string[] = [];
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('remove_compression_policy')) calls.push('remove');
      if (sql.includes('add_compression_policy')) calls.push('add');
      return Promise.resolve({ rows: [] }) as never;
    });

    await expect(
      withSessionsCompressionPaused(async () => {
        throw new Error('import failed');
      })
    ).rejects.toThrow('import failed');

    expect(calls).toEqual(['remove', 'add']);
  });

  it('does not attempt to re-add the policy if removing it failed', async () => {
    let addAttempts = 0;
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('remove_compression_policy')) {
        return Promise.reject(new Error('extension not installed')) as never;
      }
      if (sql.includes('add_compression_policy')) {
        addAttempts++;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    const result = await withSessionsCompressionPaused(async () => 'still ran');

    expect(result).toBe('still ran');
    expect(addAttempts).toBe(0);
  });

  it('logs a recovery command if restoring the policy fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('add_compression_policy')) {
        return Promise.reject(new Error('connection lost')) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await withSessionsCompressionPaused(async () => 'ok');

    expect(errorSpy).toHaveBeenCalled();
    const msg = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toMatch(/add_compression_policy/);
  });
});

/**
 * initTimescaleDB() runs dozens of statements through the same db.execute mock.
 * Rather than hand-stubbing every call per test, these rules describe a
 * "fully idempotent / nothing to do" happy path (extension installed,
 * license already Community Edition, toolkit already enabled, sessions
 * already a hypertable, all four aggregates already existing at the current
 * schema version, compression already enabled with correct orderby, all
 * seven engagement views already present). Each test then overrides just the
 * statement(s) relevant to the failure mode under test - everything else
 * falls through to this default so a single unguarded statement failing is
 * the only variable.
 */
type ExecResponder = () => unknown;
interface ExecRule {
  match: (sqlText: string) => boolean;
  respond: ExecResponder;
}

function rule(pattern: string | RegExp, respond: ExecResponder): ExecRule {
  const match =
    typeof pattern === 'string'
      ? (t: string) => t.includes(pattern)
      : (t: string) => pattern.test(t);
  return { match, respond };
}

/** Returns a fixed sequence of responses, repeating the last one once exhausted. */
function queueRule(pattern: string | RegExp, values: unknown[]): ExecRule {
  let i = 0;
  const match =
    typeof pattern === 'string'
      ? (t: string) => t.includes(pattern)
      : (t: string) => pattern.test(t);
  return {
    match,
    respond: () => {
      const v = values[Math.min(i, values.length - 1)];
      i++;
      return v;
    },
  };
}

function defaultTimescaleRules(): ExecRule[] {
  return [
    // isTimescaleInstalled - note the trailing quote means this never matches
    // the '..._toolkit' variant below (different literal text).
    rule("extname = 'timescaledb'", () => ({ rows: [{ installed: true }] })),
    rule('SHOW timescaledb.license', () => ({ rows: [{ timescaledb_license: 'timescale' }] })),
    rule("name = 'timescaledb_toolkit'", () => ({ rows: [{ available: true }] })), // isToolkitAvailableOnSystem
    rule("extname = 'timescaledb_toolkit'", () => ({ rows: [{ installed: true }] })), // isToolkitInstalled
    rule('is_hypertable', () => ({ rows: [{ is_hypertable: true }] })), // isSessionsHypertable
    // getContinuousAggregates (sessions hypertable) - all session-backed aggregates already exist
    rule(/SELECT view_name[\s\S]*hypertable_name = 'sessions'/, () => ({
      rows: [{ view_name: 'daily_content_engagement' }, { view_name: 'daily_bandwidth_by_user' }],
    })),
    // getLibrarySnapshotAggregates - both library aggregates already exist
    rule("hypertable_name = 'library_snapshots'", () => ({
      rows: [{ view_name: 'library_stats_daily' }, { view_name: 'content_quality_daily' }],
    })),
    // continuousAggregateExists(name) - default: whatever is being checked already exists
    rule('WHERE view_name =', () => ({ rows: [{ exists: 1 }] })),
    // getStoredSchemaVersion / setStoredSchemaVersion's INSERT (both mention this literal) -
    // report the current version so no rebuild is triggered
    rule('aggregate_schema_version', () => ({
      rows: [{ value: String(AGGREGATE_SCHEMA_VERSION) }],
    })),
    rule('SELECT compression_enabled', () => ({ rows: [{ compression_enabled: true }] })),
    rule('compression_settings', () => ({
      rows: [{ attname: 'started_at', orderby_column_index: 1 }],
    })),
    // engagementViewsExist - 7 engagement views all present (see ENGAGEMENT_VIEWS in timescale.ts)
    rule('FROM information_schema.views', () => ({ rows: [{ count: 7 }] })),
  ];
}

function makeInitExecuteImpl(overrides: ExecRule[]) {
  const rules = [...overrides, ...defaultTimescaleRules()];
  return (q: unknown) => {
    const text = executedSql([q]);
    for (const r of rules) {
      if (r.match(text)) {
        try {
          const result = r.respond();
          return (result instanceof Promise ? result : Promise.resolve(result)) as never;
        } catch (err) {
          const asError = err instanceof Error ? err : new Error(String(err));
          return Promise.reject(asError) as never;
        }
      }
    }
    return Promise.resolve({ rows: [] }) as never;
  };
}

describe('initTimescaleDB - optional-step guards do not abort init', () => {
  beforeEach(() => {
    executeMock().mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not abort when CREATE EXTENSION timescaledb_toolkit requires superuser', async () => {
    executeMock().mockImplementation(
      makeInitExecuteImpl([
        rule("extname = 'timescaledb_toolkit'", () => ({ rows: [{ installed: false }] })),
        rule('CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit', () => {
          throw new Error('must be superuser to create extension "timescaledb_toolkit"');
        }),
      ])
    );

    const result = await initTimescaleDB();

    expect(result.success).toBe(true);
    expect(result.actions).toContain(
      'TimescaleDB Toolkit: skipped (requires superuser - optional)'
    );
    // Pins the bug: every statement scheduled after the toolkit block must
    // still have executed. Without the try/catch around CREATE EXTENSION,
    // the thrown error propagates out of initTimescaleDB(), the caller in
    // index.ts catches it and logs "continuing without optimization", and
    // NONE of the actions below are ever reached.
    expect(result.actions).toContain('Sessions already a hypertable');
    expect(result.actions).toContain('All continuous aggregates exist and up-to-date');
    expect(result.actions).toContain('Compression already enabled with correct settings');
    expect(result.actions).toContain('Engagement views already exist');
  });

  it('does not abort when compression cannot be enabled/fixed (B1)', async () => {
    executeMock().mockImplementation(
      makeInitExecuteImpl([
        // Existing install: compression already enabled, but orderby settings
        // drifted (no explicit orderby column) - matches the reviewer's traced
        // scenario (Apache license switch failed above, so the later
        // functionality is unavailable).
        rule('compression_settings', () => ({ rows: [] })),
        rule(/ALTER TABLE sessions SET \(/, () => {
          throw new Error('functionality not supported under the current license');
        }),
      ])
    );

    const result = await initTimescaleDB();

    expect(result.success).toBe(true);
    expect(result.actions.some((a) => a.startsWith('Compression: skipped'))).toBe(true);
    // Pins the bug: partial indexes, content indexes, and the engagement
    // views all sit after the compression block and must still run.
    expect(result.actions).toContain('Sessions already a hypertable');
    expect(result.actions).toContain('All continuous aggregates exist and up-to-date');
    expect(result.actions).toContain('Engagement views already exist');
  });

  it('isolates a single failed aggregate creation instead of aborting (B2)', async () => {
    executeMock().mockImplementation(
      makeInitExecuteImpl([
        // No session-backed aggregates exist yet (library ones already do,
        // via the default rule), so createContinuousAggregates() runs and
        // processes definitions in order: daily_content_engagement,
        // daily_bandwidth_by_user, library_stats_daily, content_quality_daily.
        rule(/SELECT view_name[\s\S]*hypertable_name = 'sessions'/, () => ({ rows: [] })),
        rule('aggregate_schema_version', () => ({ rows: [] })), // fresh install: storedVersion = 0
        // continuousAggregateExists(name) is called once per definition (in
        // the loop) plus once more at the end for daily_content_engagement
        // specifically: not-exists, not-exists, exists, exists, then exists
        // (created successfully by the first call below).
        queueRule('WHERE view_name =', [
          { rows: [] },
          { rows: [] },
          { rows: [{ exists: 1 }] },
          { rows: [{ exists: 1 }] },
          { rows: [{ exists: 1 }] },
        ]),
        rule('CREATE MATERIALIZED VIEW IF NOT EXISTS daily_bandwidth_by_user', () => {
          throw new Error(
            'could not create "daily_bandwidth_by_user" materialized view (simulated)'
          );
        }),
      ])
    );

    const result = await initTimescaleDB();

    expect(result.success).toBe(true);
    const createdMsg = result.actions.find((a) => a.startsWith('Created continuous aggregates:'));
    expect(createdMsg).toBeDefined();
    expect(createdMsg).toContain('daily_content_engagement');
    expect(createdMsg).not.toContain('daily_bandwidth_by_user');
    expect(
      result.actions.some((a) =>
        a.startsWith('Warning: Failed to create aggregate daily_bandwidth_by_user')
      )
    ).toBe(true);
    // Pins the bug: without per-aggregate isolation, the second aggregate's
    // failure would propagate out of createContinuousAggregates() and abort
    // init before compression/indexes/engagement views ever ran - even
    // though daily_content_engagement (which /library/watch depends on) was
    // already created successfully.
    expect(result.actions).toContain('Compression already enabled with correct settings');
    expect(result.actions).toContain('Engagement views already exist');
  });
});
