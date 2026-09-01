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
  isCompressionPolicyDegraded,
  retryDegradedCompressionPolicy,
  _resetDegradedCacheForTests,
  getTimescaleStatus,
  invalidateTimescaleStatusCache,
  coerceRefreshBound,
  floorToUtcDay,
  alignRefreshWindow,
  refreshAggregates,
  safeFullRefreshAggregate,
  safeFullRefreshAllAggregates,
  shouldResumeBackfillInsteadOfRebuild,
  getCompressedSessionChunkRanges,
  getSessionsCompressionHorizon,
  uncapDecompressionForTx,
  MAX_TUPLES_DECOMPRESSED_GUC,
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

/**
 * Bound values of a drizzle sql template, in order. queryChunks interleaves
 * StringChunk objects (the literal SQL) with the interpolated values, so the
 * plain strings are the bound params.
 */
function executedParams(call: unknown[]): unknown[] {
  const arg = call[0] as { queryChunks?: unknown[] };
  return (arg?.queryChunks ?? []).filter((c) => typeof c === 'string');
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

  it('retries once and restores the policy without marking it degraded', async () => {
    let addAttempts = 0;
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('add_compression_policy')) {
        addAttempts++;
        if (addAttempts === 1) return Promise.reject(new Error('connection lost')) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await withSessionsCompressionPaused(async () => 'ok', 0);

    expect(addAttempts).toBe(2);
    // Recovering on the retry never writes the degraded-flag row.
    const insertedDegraded = executeMock().mock.calls.some((call) =>
      executedSql(call).includes('INSERT INTO timescale_metadata')
    );
    expect(insertedDegraded).toBe(false);
  });

  it('logs a recovery command and marks the policy degraded if both restore attempts fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('add_compression_policy')) {
        return Promise.reject(new Error('connection lost')) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await withSessionsCompressionPaused(async () => 'ok', 0);

    expect(errorSpy).toHaveBeenCalled();
    const msg = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toMatch(/add_compression_policy/);

    const insertedDegraded = executeMock().mock.calls.some((call) =>
      executedSql(call).includes('INSERT INTO timescale_metadata')
    );
    expect(insertedDegraded).toBe(true);
  });
});

describe('isCompressionPolicyDegraded / retryDegradedCompressionPolicy', () => {
  beforeEach(() => {
    executeMock().mockReset();
    _resetDegradedCacheForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports not degraded when no flag row exists', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    expect(await isCompressionPolicyDegraded()).toBe(false);
  });

  it('reports degraded when the flag row exists', async () => {
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('SELECT 1 FROM timescale_metadata')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] }) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    expect(await isCompressionPolicyDegraded()).toBe(true);
  });

  it('clears the flag once the retry succeeds', async () => {
    let degraded = true;
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('SELECT 1 FROM timescale_metadata')) {
        return Promise.resolve({ rows: degraded ? [{ '?column?': 1 }] : [] }) as never;
      }
      if (sql.includes('DELETE FROM timescale_metadata')) {
        degraded = false;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await retryDegradedCompressionPolicy();

    expect(await isCompressionPolicyDegraded()).toBe(false);
  });

  it('is a no-op when nothing is degraded', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    await retryDegradedCompressionPolicy();

    const addCalled = executeMock().mock.calls.some((call) =>
      executedSql(call).includes('add_compression_policy')
    );
    expect(addCalled).toBe(false);
  });

  it('caches the healthy answer instead of re-querying every call', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    await isCompressionPolicyDegraded();
    const queriesAfterFirst = executeMock().mock.calls.length;
    await isCompressionPolicyDegraded();
    await isCompressionPolicyDegraded();

    expect(executeMock().mock.calls.length).toBe(queriesAfterFirst);
  });
});

describe('safeFullRefreshAggregate / safeFullRefreshAllAggregates', () => {
  beforeEach(() => {
    executeMock().mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('continues past a failed batch and reports it instead of silently dropping it', async () => {
    let calls = 0;
    executeMock().mockImplementation(() => {
      calls++;
      if (calls === 2) return Promise.reject(new Error('lock timeout')) as never;
      return Promise.resolve({ rows: [] }) as never;
    });

    const failed = await safeFullRefreshAggregate(
      'daily_content_engagement',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-04-01T00:00:00Z'),
      { batchDays: 30, delayBetweenBatches: 0 }
    );

    // 3 monthly batches attempted despite the middle one failing.
    expect(calls).toBe(3);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.aggregate).toBe('daily_content_engagement');
  });

  it('returns no failures when every batch succeeds', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    const failed = await safeFullRefreshAggregate(
      'daily_content_engagement',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
      { delayBetweenBatches: 0 }
    );

    expect(failed).toEqual([]);
  });

  it('throws naming the failed ranges when any batch failed, so a partial backfill is never mistaken for a complete one', async () => {
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('MIN(started_at)')) {
        return Promise.resolve({
          rows: [{ earliest: '2026-01-01T00:00:00Z', latest: '2026-01-05T00:00:00Z' }],
        }) as never;
      }
      if (sql.includes('CALL refresh_continuous_aggregate')) {
        return Promise.reject(new Error('lock timeout')) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await expect(safeFullRefreshAllAggregates({ delayBetweenBatches: 0 })).rejects.toThrow(
      /failed batch/
    );
  });

  it('resolves normally when nothing failed', async () => {
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('MIN(started_at)')) {
        return Promise.resolve({
          rows: [{ earliest: '2026-01-01T00:00:00Z', latest: '2026-01-05T00:00:00Z' }],
        }) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });

    await expect(safeFullRefreshAllAggregates({ delayBetweenBatches: 0 })).resolves.toBeUndefined();
  });
});

describe('coerceRefreshBound', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through a valid Date unchanged', () => {
    const fallback = new Date('2020-01-01T00:00:00Z');
    const value = new Date('2026-07-01T00:00:00Z');

    const result = coerceRefreshBound(value, fallback, 'startTime');

    expect(result.getTime()).toBe(value.getTime());
  });

  it('parses a valid ISO string (raw db.execute results return timestamptz as strings)', () => {
    const fallback = new Date('2020-01-01T00:00:00Z');

    const result = coerceRefreshBound('2026-07-01T00:00:00Z', fallback, 'startTime');

    expect(result.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back and logs loudly on an unparseable string', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fallback = new Date('2020-01-01T00:00:00Z');

    const result = coerceRefreshBound('not-a-date', fallback, 'startTime');

    expect(result.getTime()).toBe(fallback.getTime());
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.join(' ') ?? '';
    expect(message).toContain('startTime');
    expect(message).toContain('not-a-date');
  });

  it('falls back and logs loudly on an already-invalid Date', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fallback = new Date('2020-01-01T00:00:00Z');
    const invalidDate = new Date(NaN);

    const result = coerceRefreshBound(invalidDate, fallback, 'endTime');

    expect(result.getTime()).toBe(fallback.getTime());
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.join(' ')).toContain('endTime');
  });

  it('falls back without logging when the value is undefined', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fallback = new Date('2020-01-01T00:00:00Z');

    const result = coerceRefreshBound(undefined, fallback, 'startTime');

    expect(result.getTime()).toBe(fallback.getTime());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('floorToUtcDay', () => {
  it('floors mid-day to UTC midnight', () => {
    const midDay = new Date('2026-08-01T13:07:59.578Z');
    expect(floorToUtcDay(midDay).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('leaves already-aligned dates untouched', () => {
    const midnight = new Date('2026-08-01T00:00:00.000Z');
    expect(floorToUtcDay(midnight).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('stays on the same day at the last millisecond of the year', () => {
    expect(floorToUtcDay(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z'
    );
  });

  it('floors pre-epoch timestamps down, not up', () => {
    expect(floorToUtcDay(new Date('1969-12-31T23:59:59.999Z')).toISOString()).toBe(
      '1969-12-31T00:00:00.000Z'
    );
  });

  it('keeps years 0-99 in their own century', () => {
    // Date.UTC(1, 0, 1, 5) means 1901, not year 1 - so the year has to come
    // from the epoch value. This is the trap the arithmetic version avoids.
    const yearOneAtFive = new Date(-62135578800000);
    expect(yearOneAtFive.getUTCFullYear()).toBe(1);
    expect(yearOneAtFive.toISOString()).toBe('0001-01-01T05:00:00.000Z');

    const floored = floorToUtcDay(yearOneAtFive);
    expect(floored.getUTCFullYear()).toBe(1);
    expect(floored.toISOString()).toBe('0001-01-01T00:00:00.000Z');
  });
});

describe('alignRefreshWindow', () => {
  it('floors both ends of a window spanning different days', () => {
    const window = alignRefreshWindow(
      new Date('2026-07-01T09:30:00.000Z'),
      new Date('2026-08-01T13:07:59.578Z')
    );

    expect(window?.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window?.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns null when both bounds land in the same UTC day', () => {
    expect(
      alignRefreshWindow(new Date('2026-08-01T05:00:00.000Z'), new Date('2026-08-01T13:00:00.000Z'))
    ).toBeNull();
  });

  it('returns null for an inverted window', () => {
    expect(
      alignRefreshWindow(new Date('2026-08-05T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'))
    ).toBeNull();
  });
});

describe('refreshAggregates window wiring', () => {
  beforeEach(() => {
    executeMock().mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fullRefresh issues the unbounded NULL, NULL call', async () => {
    executeMock().mockImplementation((q: unknown) => {
      const s = executedSql([q]);
      if (s.includes('pg_extension'))
        return Promise.resolve({ rows: [{ installed: true }] }) as never;
      if (s.includes('continuous_aggregates'))
        return Promise.resolve({ rows: [{ view_name: 'daily_content_engagement' }] }) as never;
      return Promise.resolve({ rows: [] }) as never;
    });

    await refreshAggregates({ fullRefresh: true });

    const calls = executeMock().mock.calls.map((c: unknown[]) => executedSql(c));
    const refreshCalls = calls.filter((s: string) => s.includes('refresh_continuous_aggregate'));
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toContain('NULL, NULL');
  });

  it('a same-day bounded window issues no refresh call at all', async () => {
    executeMock().mockImplementation((q: unknown) => {
      const s = executedSql([q]);
      if (s.includes('pg_extension'))
        return Promise.resolve({ rows: [{ installed: true }] }) as never;
      if (s.includes('continuous_aggregates'))
        return Promise.resolve({ rows: [{ view_name: 'daily_content_engagement' }] }) as never;
      return Promise.resolve({ rows: [] }) as never;
    });

    await refreshAggregates({
      startTime: new Date('2026-08-05T05:00:00.000Z'),
      endTime: new Date('2026-08-05T13:00:00.000Z'),
    });

    const calls = executeMock().mock.calls.map((c: unknown[]) => executedSql(c));
    expect(calls.some((s: string) => s.includes('refresh_continuous_aggregate'))).toBe(false);
  });
});

describe('safeFullRefreshAggregate window alignment', () => {
  beforeEach(() => {
    executeMock().mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the sub-day tail of the final batch instead of materializing today', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    // The shape from the field: a multi-day range whose end bound is mid-day.
    const failed = await safeFullRefreshAggregate(
      'daily_content_engagement',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-08-01T13:07:59.578Z'),
      { batchDays: 30, delayBetweenBatches: 0 }
    );

    expect(failed).toEqual([]);
    // 31 whole days in 30-day batches: Jul 1 -> Jul 31, then Jul 31 -> Aug 1.
    expect(executeMock()).toHaveBeenCalledTimes(2);
    expect(executedParams(executeMock().mock.calls[0] as unknown[])).toEqual([
      'daily_content_engagement',
      '2026-07-01T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z',
    ]);
    expect(executedParams(executeMock().mock.calls[1] as unknown[])).toEqual([
      'daily_content_engagement',
      '2026-07-31T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
    // The end bound is floored to Aug 1 midnight, never inflated past the tail.
    const serialized = JSON.stringify(executeMock().mock.calls);
    expect(serialized).toContain('2026-08-01T00:00:00.000Z');
    expect(serialized).not.toContain('13:07:59');
  });

  it('skips the refresh entirely when the window collapses inside one UTC day', async () => {
    executeMock().mockImplementation(() => Promise.resolve({ rows: [] }) as never);

    const failed = await safeFullRefreshAggregate(
      'x',
      new Date('2026-08-01T05:00:00Z'),
      new Date('2026-08-01T13:00:00Z'),
      { delayBetweenBatches: 0 }
    );

    expect(failed).toEqual([]);
    expect(executeMock()).not.toHaveBeenCalled();
  });
});

describe('shouldResumeBackfillInsteadOfRebuild', () => {
  it('resumes when the marker targets the current version and no aggregates are missing', () => {
    const marker = { targetVersion: 13, startedAt: '2026-07-01T00:00:00Z' };
    expect(shouldResumeBackfillInsteadOfRebuild(marker, 13, 0)).toBe(true);
  });

  it('rebuilds when there is no marker (fresh version-mismatch, not a retry)', () => {
    expect(shouldResumeBackfillInsteadOfRebuild(null, 13, 0)).toBe(false);
  });

  it('rebuilds when the marker targets an older version than the current one', () => {
    const marker = { targetVersion: 12, startedAt: '2026-07-01T00:00:00Z' };
    expect(shouldResumeBackfillInsteadOfRebuild(marker, 13, 0)).toBe(false);
  });

  it('rebuilds when an expected aggregate view is missing, even with a matching marker', () => {
    const marker = { targetVersion: 13, startedAt: '2026-07-01T00:00:00Z' };
    expect(shouldResumeBackfillInsteadOfRebuild(marker, 13, 1)).toBe(false);
  });
});

describe('compressed sessions chunk catalog', () => {
  /** Stub the extension gate as installed; everything else answers with rows. */
  function stubChunks(rows: unknown[]) {
    executeMock().mockImplementation((q: unknown) => {
      const s = executedSql([q]);
      if (s.includes('pg_extension')) {
        return Promise.resolve({ rows: [{ installed: true }] }) as never;
      }
      return Promise.resolve({ rows }) as never;
    });
  }

  function chunkQuerySql(): string {
    return (
      executeMock()
        .mock.calls.map((c: unknown[]) => executedSql(c))
        .find((s: string) => s.includes('timescaledb_information.chunks')) ?? ''
    );
  }

  beforeEach(() => {
    executeMock().mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists compressed chunk ranges newest first, as Date pairs', async () => {
    // node-postgres parses timestamptz to Date; a raw execute can also hand
    // back the text form, so both shapes have to map.
    stubChunks([
      {
        range_start: new Date('2026-02-01T00:00:00.000Z'),
        range_end: new Date('2026-03-03T00:00:00.000Z'),
      },
      { range_start: '2026-01-02T00:00:00.000Z', range_end: '2026-02-01T00:00:00.000Z' },
    ]);

    const ranges = await getCompressedSessionChunkRanges();

    expect(chunkQuerySql()).toContain('is_compressed');
    expect(chunkQuerySql()).toContain('ORDER BY range_end DESC');
    expect(ranges).toEqual([
      { start: new Date('2026-02-01T00:00:00.000Z'), end: new Date('2026-03-03T00:00:00.000Z') },
      { start: new Date('2026-01-02T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') },
    ]);
    expect(ranges[0]?.start).toBeInstanceOf(Date);
  });

  it('asks postgres for the horizon instead of pulling every chunk row', async () => {
    stubChunks([{ horizon: new Date('2026-03-03T00:00:00.000Z') }]);

    const horizon = await getSessionsCompressionHorizon();

    expect(chunkQuerySql()).toContain('max(range_end)');
    expect(chunkQuerySql()).not.toContain('ORDER BY');
    expect(horizon).toEqual(new Date('2026-03-03T00:00:00.000Z'));
  });

  it('returns a null horizon when nothing is compressed', async () => {
    stubChunks([{ horizon: null }]);

    expect(await getSessionsCompressionHorizon()).toBeNull();
  });
});

describe('getTimescaleStatus cache', () => {
  function stubCatalog() {
    executeMock().mockImplementation((q: unknown) => {
      const sql = executedSql([q]);
      if (sql.includes('pg_extension')) {
        return Promise.resolve({ rows: [{ installed: true }] }) as never;
      }
      if (sql.includes('compression_enabled')) {
        return Promise.resolve({ rows: [{ compression_enabled: true }] }) as never;
      }
      if (sql.includes('timescaledb_information.hypertables')) {
        return Promise.resolve({ rows: [{ is_hypertable: true }] }) as never;
      }
      if (sql.includes('continuous_aggregates')) {
        return Promise.resolve({ rows: [{ view_name: 'daily_content_engagement' }] }) as never;
      }
      if (sql.includes('timescaledb_information.chunks')) {
        return Promise.resolve({ rows: [{ count: 7 }] }) as never;
      }
      return Promise.resolve({ rows: [] }) as never;
    });
  }

  beforeEach(() => {
    executeMock().mockReset();
    invalidateTimescaleStatusCache();
    stubCatalog();
  });

  afterEach(() => {
    invalidateTimescaleStatusCache();
    vi.useRealTimers();
  });

  it('runs the catalog queries once, then serves cached within the TTL', async () => {
    const first = await getTimescaleStatus();
    const callsAfterFirst = executeMock().mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(first.chunkCount).toBe(7);

    const second = await getTimescaleStatus();
    expect(second).toEqual(first);
    // No additional catalog queries while the cache is warm.
    expect(executeMock().mock.calls.length).toBe(callsAfterFirst);
  });

  it('refetches after the cache is invalidated', async () => {
    await getTimescaleStatus();
    const callsAfterFirst = executeMock().mock.calls.length;

    invalidateTimescaleStatusCache();
    await getTimescaleStatus();
    expect(executeMock().mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    await getTimescaleStatus();
    const callsAfterFirst = executeMock().mock.calls.length;

    // Within the TTL: still cached.
    vi.advanceTimersByTime(4 * 60 * 1000);
    await getTimescaleStatus();
    expect(executeMock().mock.calls.length).toBe(callsAfterFirst);

    // Past the 5-minute TTL: refetches.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await getTimescaleStatus();
    expect(executeMock().mock.calls.length).toBe(callsAfterFirst * 2);
  });
});

describe('uncapDecompressionForTx', () => {
  it('issues SET LOCAL when the GUC exists', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await uncapDecompressionForTx({ execute });

    expect(execute).toHaveBeenCalledTimes(2);
    const setCall = executedSql([execute.mock.calls[1]![0]]);
    expect(setCall).toBe(`SET LOCAL ${MAX_TUPLES_DECOMPRESSED_GUC} = 0`);
  });

  it('is a no-op on plain postgres (GUC absent)', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    await uncapDecompressionForTx({ execute });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * initTimescaleDB() runs dozens of statements through the same db.execute mock.
 * Rather than hand-stubbing every call per test, these rules describe a
 * "fully idempotent / nothing to do" happy path (extension installed,
 * license already Community Edition, toolkit already enabled, sessions
 * already a hypertable, all four aggregates already existing at the current
 * schema version, compression already enabled with correct orderby, all
 * all engagement views already present). Each test then overrides just the
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
      rows: [
        { view_name: 'daily_content_engagement' },
        { view_name: 'user_media_plays_daily' },
        { view_name: 'daily_bandwidth_by_user' },
      ],
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
    // engagementViewsExist - all 8 engagement views present (see ENGAGEMENT_VIEWS in timescale.ts)
    rule('FROM information_schema.views', () => ({ rows: [{ count: 8 }] })),
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
        // user_media_plays_daily, daily_bandwidth_by_user, library_stats_daily,
        // content_quality_daily.
        rule(/SELECT view_name[\s\S]*hypertable_name = 'sessions'/, () => ({ rows: [] })),
        rule('aggregate_schema_version', () => ({ rows: [] })), // fresh install: storedVersion = 0
        // continuousAggregateExists(name) is called once per definition (in
        // the loop) plus once more at the end for daily_content_engagement
        // specifically: the three session-backed ones do not exist yet, the two
        // library ones do, then the final check finds daily_content_engagement
        // created successfully by the first call below.
        queueRule('WHERE view_name =', [
          { rows: [] },
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
