import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { reconcileForkLedger, FORK_LEDGER_MILLIS } from '../forkLedgerReconcile.js';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/**
 * Answers the reconciler's two probe queries and records everything else, so a
 * test can describe a database by its ledger alone.
 */
function fakeClient(opts: { ledgerExists?: boolean; forkRows?: number; failOn?: RegExp } = {}) {
  const { ledgerExists = true, forkRows = 0, failOn } = opts;
  const queries: string[] = [];
  const query = vi.fn(async (text: string, _params?: unknown[]): Promise<QueryResult> => {
    queries.push(text);
    if (failOn?.test(text)) throw new Error('boom');
    if (text.includes('to_regclass')) return { rows: [{ present: ledgerExists }], rowCount: 1 };
    if (text.includes('count(*)')) return { rows: [{ count: String(forkRows) }], rowCount: 1 };
    if (text.includes('max(created_at)'))
      return { rows: [{ created_at: '1783716244207' }], rowCount: 1 };
    return { rows: [], rowCount: forkRows };
  });
  return { client: { query } as never, queries, query };
}

describe('reconcileForkLedger', () => {
  it('does nothing when the ledger table does not exist yet (fresh install)', async () => {
    const { client, queries } = fakeClient({ ledgerExists: false });

    await expect(reconcileForkLedger(client)).resolves.toBe(false);

    expect(queries).toHaveLength(1);
  });

  it('does nothing when no fork-era ledger rows are present', async () => {
    const { client, queries } = fakeClient({ forkRows: 0 });

    await expect(reconcileForkLedger(client)).resolves.toBe(false);

    expect(queries.some((q) => q.includes('BEGIN'))).toBe(false);
    expect(queries.some((q) => q.includes('DELETE'))).toBe(false);
  });

  it('removes exactly the five fork rows inside one transaction, after reshaping what they left behind', async () => {
    const { client, queries, query } = fakeClient({ forkRows: 5 });

    await expect(reconcileForkLedger(client)).resolves.toBe(true);

    expect(queries[2]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');

    // the ledger delete is what unblocks the migrator, and it must come after
    // the reshaping steps - a rollback in between has to take both back
    const deleteIndex = queries.findIndex((q) =>
      q.includes('DELETE FROM drizzle.__drizzle_migrations')
    );
    const librariesIndex = queries.findIndex((q) =>
      q.includes('RENAME COLUMN "type" TO "media_type"')
    );
    const parkIndex = queries.findIndex((q) => q.includes('ombi_requests_legacy'));
    expect(librariesIndex).toBeGreaterThan(-1);
    expect(parkIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(librariesIndex);
    expect(deleteIndex).toBeGreaterThan(parkIndex);

    // scoped to the fork's own five timestamps - never a range or a truncate
    const deleteCall = query.mock.calls.find((c) => String(c[0]).includes('DELETE FROM drizzle'));
    expect(deleteCall?.[1]).toEqual([[...FORK_LEDGER_MILLIS]]);
    expect(FORK_LEDGER_MILLIS).toHaveLength(5);
  });

  it('rolls back and rethrows if a reshaping step fails, leaving the ledger untouched', async () => {
    const { client, queries } = fakeClient({ forkRows: 5, failOn: /RENAME COLUMN/ });

    await expect(reconcileForkLedger(client)).rejects.toThrow('boom');

    expect(queries).toContain('ROLLBACK');
    expect(queries.some((q) => q.includes('DELETE FROM drizzle'))).toBe(false);
    expect(queries).not.toContain('COMMIT');
  });
});

describe('migrations a reconciled fork database re-enters', () => {
  // The reconciliation drops the high-water mark back to upstream 0066, so
  // drizzle replays 0067..0097 against a database that already holds some of
  // those objects under the fork's own numbering. These two files are the
  // overlap, and they only survive it while every statement is idempotent.
  it.each(['0074_add_libraries_table.sql', '0097_fork_media_requests_and_played_state.sql'])(
    '%s creates nothing unconditionally',
    (file) => {
      const sql = readFileSync(`${import.meta.dirname}/../migrations/${file}`, 'utf8');

      expect(sql).not.toMatch(/CREATE TABLE "/);
      expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX "/);
      // ADD CONSTRAINT has no IF NOT EXISTS in Postgres; each one is guarded
      for (const match of sql.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)) {
        expect(sql).toContain(`conname = '${match[1]}'`);
      }
    }
  );
});
