/**
 * Seerr Sync Queue tests
 *
 * Tests runSeerrSync() and buildSeerrRequesterResolver() in isolation from
 * BullMQ (mirrors jobs/plexTokenRefresh.test.ts / jobs/ombiSyncQueue.test.ts -
 * the queue/worker plumbing is a thin wrapper around these pure-ish
 * functions). Mocks db, settings, and the Seerr HTTP client - no live
 * network, no live Postgres/Redis.
 *
 * Covers: unconfigured no-op, single-phase upsert+prune, prune suppressed on
 * validation failure AND on inconsistent pagination (design §6 step 6), the
 * ADR 0008 resolution pipeline (manual override, external-id tier incl.
 * ambiguity refusal, username fallback, unattributed), source scoping (never
 * touches Ombi rows), and cache invalidation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { SeerrSyncRecord } from '../../services/seerr.js';
import type { SeerrSyncStatusInternal } from '../../services/settings.js';

const mockFetchAllRequests = vi.fn();
const mockGetRequestCount = vi.fn();
// Identity by default (SEERR-04 - the fetch/resolve catch block now calls
// seerr.redact() on the failure message); tests that care about actual
// redaction override this per-test.
const mockRedact = vi.fn((message: string) => message);

vi.mock('../../services/seerr.js', () => ({
  // Must be a `function`, not an arrow, so `new SeerrService(...)` works -
  // an explicit object return from a constructor function replaces `this`.
  SeerrService: vi.fn().mockImplementation(function () {
    return {
      fetchAllRequests: mockFetchAllRequests,
      getRequestCount: mockGetRequestCount,
      redact: mockRedact,
    };
  }),
}));

vi.mock('../../services/settings.js', () => ({
  getSeerrSettings: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/cache.js', () => ({
  getPubSubService: vi.fn(() => null),
}));

vi.mock('../../serverState.js', () => ({ isMaintenance: () => false }));

import { db } from '../../db/client.js';
import { SeerrService } from '../../services/seerr.js';
import { getSeerrSettings, getSetting, setSetting } from '../../services/settings.js';
import {
  runSeerrSync,
  buildSeerrRequesterResolver,
  invalidateSeerrCaches,
} from '../seerrSyncQueue.js';

// ============================================================================
// Fixtures
// ============================================================================

function seerrRecord(overrides: Partial<SeerrSyncRecord> = {}): SeerrSyncRecord {
  return {
    seerrRequestId: 1,
    mediaType: 'movie',
    title: null,
    releaseYear: null,
    imdbId: 'tt1234567',
    tmdbId: 42,
    tvdbId: null,
    seasons: null,
    is4k: false,
    status: 'available',
    requestedAt: new Date('2025-03-03T09:07:45.000Z'),
    availableAt: null,
    requester: {
      seerrUserId: 'seerr-user-1',
      seerrUsername: 'alice',
      seerrAlias: null,
      externalUserId: null,
    },
    ...overrides,
  };
}

/** Chainable insert().values().onConflictDoUpdate() + delete().where().returning() tx mock. */
function makeTx(pruneRows: { id: string }[] = []) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(pruneRows),
      })),
    })),
  };
}

function mockTransaction(pruneRows: { id: string }[] = []) {
  const tx = makeTx(pruneRows);
  vi.mocked(db.transaction).mockImplementation(
    (cb: unknown) => (cb as (t: unknown) => unknown)(tx) as never
  );
  return tx;
}

function mockTopLevelDelete(pruneRows: { id: string }[] = []) {
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue(pruneRows),
    })),
  } as never);
}

/** Empty resolver maps by default (no mappings, no server users, no Tracearr users). */
function mockResolverQueries({
  mappings = [] as Array<{ sourceUserId: string; userId: string | null }>,
  serverUsersRows = [] as Array<{
    externalId: string | null;
    plexAccountId: string | null;
    userId: string;
  }>,
  usersRows = [] as Array<{ id: string; username: string }>,
} = {}) {
  vi.mocked(db.select).mockImplementation((columns: unknown) => {
    const cols = columns as Record<string, unknown>;
    if ('externalId' in cols) {
      return { from: () => Promise.resolve(serverUsersRows) } as never;
    }
    if ('username' in cols) {
      return { from: () => Promise.resolve(usersRows) } as never;
    }
    return { from: () => ({ where: () => Promise.resolve(mappings) }) } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolverQueries();
  mockTransaction();
  mockTopLevelDelete();
});

// ============================================================================
// runSeerrSync
// ============================================================================

describe('runSeerrSync', () => {
  it('is a complete no-op when Seerr is not configured', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });

    const result = await runSeerrSync('scheduled');

    expect(result).toEqual({
      configured: false,
      phase: { ok: true, processed: 0, skipped: 0, pruned: 0, error: null },
    });
    expect(SeerrService).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('is a no-op when only one of url/apiKey is set (partial configuration)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: null,
    });

    const result = await runSeerrSync('scheduled');

    expect(result.configured).toBe(false);
    expect(SeerrService).not.toHaveBeenCalled();
  });

  it('upserts and prunes when validation is clean and pagination is consistent', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 1,
      movie: 1,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 1,
      completed: 0,
    });
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord()],
      skipped: 0,
      paginationConsistent: true,
    });
    const tx = mockTransaction([{ id: 'pruned-1' }]);

    const result = await runSeerrSync('manual');

    expect(result.configured).toBe(true);
    expect(result.phase).toEqual({ ok: true, processed: 1, skipped: 0, pruned: 1, error: null });
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1); // prune allowed
    expect(setSetting).toHaveBeenCalledWith(
      'seerrSyncStatus',
      expect.objectContaining({ lastError: null, skippedValidation: 0 })
    );
  });

  it('suppresses prune when validation failures occurred (design §6 step 6)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 1,
      movie: 1,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 1,
      completed: 0,
    });
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord()],
      skipped: 2,
      paginationConsistent: true,
    });
    const tx = mockTransaction([{ id: 'should-not-be-counted' }]);

    const result = await runSeerrSync('scheduled');

    expect(result.phase.skipped).toBe(2);
    expect(result.phase.pruned).toBe(0);
    expect(tx.delete).not.toHaveBeenCalled(); // never even attempted
  });

  it('suppresses prune when pagination was inconsistent, even with zero validation failures (design §6 step 6)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 1,
      movie: 1,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 1,
      completed: 0,
    });
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord()],
      skipped: 0,
      paginationConsistent: false, // e.g. the hard page cap was hit
    });
    const tx = mockTransaction([{ id: 'should-not-be-counted' }]);

    const result = await runSeerrSync('scheduled');

    expect(result.phase.ok).toBe(true);
    expect(result.phase.pruned).toBe(0);
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('a failed count call does not abort the run (best-effort progress denominator only)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockRejectedValue(new Error('Seerr API error: 500'));
    mockFetchAllRequests.mockResolvedValue({ records: [], skipped: 0, paginationConsistent: true });
    mockTransaction();

    const result = await runSeerrSync('scheduled');

    expect(result.phase.ok).toBe(true);
    expect(result.phase.error).toBeNull();
  });

  it('reports a failed run when the fetch phase throws', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 0,
      movie: 0,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 0,
      completed: 0,
    });
    mockFetchAllRequests.mockRejectedValue(new Error('Seerr API error: 500 Internal Server Error'));

    const result = await runSeerrSync('scheduled');

    expect(result.phase.ok).toBe(false);
    expect(result.phase.error).toContain('500');
    expect(setSetting).toHaveBeenCalledWith(
      'seerrSyncStatus',
      expect.objectContaining({ lastError: expect.stringContaining('500') })
    );
  });

  it('redacts the API key from the fetch/resolve failure message before persisting/logging it (SEERR-04)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'super-secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 0,
      movie: 0,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 0,
      completed: 0,
    });
    // Only response.statusText is attacker-controlled text that can reach
    // this path - simulated here directly on the thrown error message.
    mockFetchAllRequests.mockRejectedValue(
      new Error('Seerr API error: 500 super-secret-key-as-reason-phrase')
    );
    mockRedact.mockImplementationOnce((message: string) =>
      message.split('super-secret-key').join('<redacted>')
    );

    const result = await runSeerrSync('scheduled');

    expect(mockRedact).toHaveBeenCalledWith(
      expect.stringContaining('super-secret-key-as-reason-phrase')
    );
    expect(result.phase.error).not.toContain('super-secret-key');
    expect(result.phase.error).toContain('<redacted>');
  });

  it('preserves the previous lastSuccessAt when the run fails', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    const previous: SeerrSyncStatusInternal = {
      lastRunAt: '2025-01-01T00:00:00.000Z',
      lastSuccessAt: '2025-01-01T00:00:00.000Z',
      lastError: null,
      skippedValidation: 0,
    };
    vi.mocked(getSetting).mockResolvedValue(previous);
    mockGetRequestCount.mockResolvedValue({
      total: 0,
      movie: 0,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 0,
      completed: 0,
    });
    mockFetchAllRequests.mockRejectedValue(new Error('network down'));

    await runSeerrSync('scheduled');

    expect(setSetting).toHaveBeenCalledWith(
      'seerrSyncStatus',
      expect.objectContaining({
        lastSuccessAt: '2025-01-01T00:00:00.000Z',
        lastError: 'network down',
      })
    );
  });

  it('reports an error and does not fetch when SeerrService construction throws (e.g. SSRF)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://169.254.169.254',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(SeerrService).mockImplementationOnce(function () {
      throw new Error('169.254.169.254 is in the link-local range');
    });

    const result = await runSeerrSync('scheduled');

    expect(result.phase.error).toContain('link-local');
    expect(mockFetchAllRequests).not.toHaveBeenCalled();
    expect(mockGetRequestCount).not.toHaveBeenCalled();
  });

  it('scopes the upsert/prune to source=seerr, never touching ombi rows', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 1,
      movie: 1,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 1,
      completed: 0,
    });
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord()],
      skipped: 0,
      paginationConsistent: true,
    });
    const tx = mockTransaction([{ id: 'pruned-1' }]);

    await runSeerrSync('manual');

    const insertedRows = (tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      .values.mock.calls[0]?.[0] as Array<{ source: string }>;
    expect(insertedRows.every((r) => r.source === 'seerr')).toBe(true);
  });

  it('chunks the insert into batches of 1000 rows to stay under the bind-parameter limit (CR-3)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetRequestCount.mockResolvedValue({
      total: 1500,
      movie: 1500,
      tv: 0,
      pending: 0,
      approved: 0,
      declined: 0,
      processing: 0,
      available: 1500,
      completed: 0,
    });
    const records = Array.from({ length: 1500 }, (_, i) => seerrRecord({ seerrRequestId: i + 1 }));
    mockFetchAllRequests.mockResolvedValue({
      records,
      skipped: 0,
      paginationConsistent: true,
    });
    const tx = mockTransaction([]);

    const result = await runSeerrSync('manual');

    expect(result.phase.processed).toBe(1500);
    // 1500 rows / 1000-row chunk size = 2 insert calls, not 1 unchunked call
    // that would bind 1500*21 ≈ 31,500 parameters (fine here, but the same
    // shape hard-fails node-postgres's 65,535-param limit above ~3,100 rows).
    expect(tx.insert).toHaveBeenCalledTimes(2);
    const firstChunk = (tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      .values.mock.calls[0]?.[0] as unknown[];
    const secondChunk = (tx.insert.mock.results[1]?.value as { values: ReturnType<typeof vi.fn> })
      .values.mock.calls[0]?.[0] as unknown[];
    expect(firstChunk).toHaveLength(1000);
    expect(secondChunk).toHaveLength(500);
  });
});

// ============================================================================
// buildSeerrRequesterResolver - ADR 0008 pipeline
// ============================================================================

describe('buildSeerrRequesterResolver', () => {
  it('resolves via the persisted external id (jellyfinUserId/plexId) - primary tier', async () => {
    mockResolverQueries({
      serverUsersRows: [{ externalId: 'jf-guid-1', plexAccountId: null, userId: 'user-2' }],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'nomatch',
      seerrAlias: null,
      externalUserId: 'jf-guid-1',
    });

    expect(result).toEqual({ userId: 'user-2', matchMethod: 'provider' });
  });

  it('refuses to guess when the external id maps to more than one distinct user (ambiguity refusal - ADR 0008 follow-up)', async () => {
    mockResolverQueries({
      serverUsersRows: [
        { externalId: 'shared-guid', plexAccountId: null, userId: 'user-1' },
        { externalId: 'shared-guid', plexAccountId: null, userId: 'user-2' },
      ],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'nomatch',
      seerrAlias: null,
      externalUserId: 'shared-guid',
    });

    // Falls through past the ambiguous external-id tier to username (no
    // match here either) -> unattributed.
    expect(result).toEqual({ userId: null, matchMethod: null });
  });

  it('falls through to username when the external id has no candidate', async () => {
    mockResolverQueries({
      usersRows: [{ id: 'user-3', username: 'bob' }],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'Bob',
      seerrAlias: null,
      externalUserId: 'unknown-guid',
    });

    expect(result).toEqual({ userId: 'user-3', matchMethod: 'username' });
  });

  it('resolves via case-insensitive username when no external id is present', async () => {
    mockResolverQueries({ usersRows: [{ id: 'user-1', username: 'Alice' }] });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'alice',
      seerrAlias: null,
      externalUserId: null,
    });

    expect(result).toEqual({ userId: 'user-1', matchMethod: 'username' });
  });

  it('refuses to guess on an ambiguous username (>1 candidate) - unattributed', async () => {
    mockResolverQueries({
      usersRows: [
        { id: 'user-1', username: 'shared' },
        { id: 'user-2', username: 'SHARED' },
      ],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'Shared',
      seerrAlias: null,
      externalUserId: null,
    });

    expect(result).toEqual({ userId: null, matchMethod: null });
  });

  it('manual override wins over an available external-id match', async () => {
    mockResolverQueries({
      mappings: [{ sourceUserId: 'seerr-1', userId: 'user-override' }],
      serverUsersRows: [{ externalId: 'jf-guid-1', plexAccountId: null, userId: 'user-2' }],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'alice',
      seerrAlias: null,
      externalUserId: 'jf-guid-1',
    });

    expect(result).toEqual({ userId: 'user-override', matchMethod: 'manual' });
  });

  it('a manual override with userId=null forces unattributed even with an external-id match available', async () => {
    mockResolverQueries({
      mappings: [{ sourceUserId: 'seerr-1', userId: null }],
      serverUsersRows: [{ externalId: 'jf-guid-1', plexAccountId: null, userId: 'user-2' }],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'alice',
      seerrAlias: null,
      externalUserId: 'jf-guid-1',
    });

    expect(result).toEqual({ userId: null, matchMethod: 'manual' });
  });

  it('falls through to unattributed with no manual/external-id/username match', async () => {
    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'nobody',
      seerrAlias: null,
      externalUserId: null,
    });

    expect(result).toEqual({ userId: null, matchMethod: null });
  });

  it('resolves via plexAccountId when jellyfinUserId/external_id is absent for that user', async () => {
    mockResolverQueries({
      serverUsersRows: [{ externalId: null, plexAccountId: 'plex-abc', userId: 'user-4' }],
    });

    const resolver = await buildSeerrRequesterResolver();
    const result = resolver.resolve({
      seerrUserId: 'seerr-1',
      seerrUsername: 'nomatch',
      seerrAlias: null,
      externalUserId: 'plex-abc',
    });

    expect(result).toEqual({ userId: 'user-4', matchMethod: 'provider' });
  });
});

// ============================================================================
// invalidateSeerrCaches
// ============================================================================

describe('invalidateSeerrCaches', () => {
  it('deletes all keys matching the library:stale and the shared requester-stats patterns', async () => {
    const keys = vi.fn((pattern: string) => {
      if (pattern.includes('stale')) return Promise.resolve(['stale:a', 'stale:b']);
      if (pattern.includes('requester-stats')) return Promise.resolve(['stats:a']);
      return Promise.resolve([]);
    });
    const del = vi.fn().mockResolvedValue(3);
    const redis = { keys, del } as unknown as Redis;

    await invalidateSeerrCaches(redis);

    expect(del).toHaveBeenCalledWith('stale:a', 'stale:b');
    expect(del).toHaveBeenCalledWith('stats:a');
  });

  it('is a no-op when no matching keys exist', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidateSeerrCaches(redis);

    expect(del).not.toHaveBeenCalled();
  });
});
