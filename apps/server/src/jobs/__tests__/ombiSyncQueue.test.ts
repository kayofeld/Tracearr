/**
 * Ombi Sync Queue tests
 *
 * Tests runOmbiSync() and buildRequesterResolver() in isolation from BullMQ
 * (mirrors jobs/plexTokenRefresh.test.ts - the queue/worker plumbing is a
 * thin wrapper around these pure-ish functions). Mocks db, settings, and the
 * Ombi HTTP client - no live network, no live Postgres/Redis.
 *
 * Covers: unconfigured no-op, phase independence (a TV failure leaves a
 * completed movie phase intact), prune-suppressed-on-validation-failure
 * (ADR 0004), the ADR 0002 resolution pipeline (manual override, provider
 * tier, ambiguous username refusal, unattributed), and lastSuccessAt
 * preserved across a failed run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { OmbiSyncRecord } from '../../services/ombi.js';
import type { OmbiSyncStatusInternal } from '../../services/settings.js';

const mockGetMovieRequests = vi.fn();
const mockGetTvRequests = vi.fn();
// Identity by default (SEERR-04 sibling fix - runPhase() now calls
// ombi.redact() on the failure path); tests that care about actual
// redaction override this per-test.
const mockRedact = vi.fn((message: string) => message);

vi.mock('../../services/ombi.js', () => ({
  // Must be a `function`, not an arrow, so `new OmbiService(...)` works -
  // an explicit object return from a constructor function replaces `this`.
  OmbiService: vi.fn().mockImplementation(function () {
    return {
      getMovieRequests: mockGetMovieRequests,
      getTvRequests: mockGetTvRequests,
      redact: mockRedact,
    };
  }),
}));

vi.mock('../../services/settings.js', () => ({
  getOmbiSettings: vi.fn(),
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
import { OmbiService } from '../../services/ombi.js';
import { getOmbiSettings, getSetting, setSetting } from '../../services/settings.js';
import { runOmbiSync, buildRequesterResolver, invalidateOmbiCaches } from '../ombiSyncQueue.js';

// ============================================================================
// Fixtures
// ============================================================================

function movieRecord(overrides: Partial<OmbiSyncRecord> = {}): OmbiSyncRecord {
  return {
    ombiRequestId: 1,
    ombiParentRequestId: null,
    mediaType: 'movie',
    title: 'Test Movie',
    releaseYear: 2020,
    imdbId: 'tt1234567',
    tmdbId: 42,
    tvdbId: null,
    seasons: null,
    is4k: false,
    status: 'available',
    requestedAt: new Date('2025-03-03T09:07:45.000Z'),
    availableAt: null,
    requester: {
      ombiUserId: 'ombi-user-1',
      ombiUsername: 'alice',
      ombiAlias: null,
      providerUserId: null,
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
  mappings = [] as Array<{ ombiUserId: string; userId: string | null }>,
  serverUsersRows = [] as Array<{ plexAccountId: string | null; userId: string }>,
  usersRows = [] as Array<{ id: string; username: string }>,
} = {}) {
  vi.mocked(db.select).mockImplementation((columns: unknown) => {
    const cols = columns as Record<string, unknown>;
    if ('plexAccountId' in cols) {
      return { from: () => ({ where: () => Promise.resolve(serverUsersRows) }) } as never;
    }
    if ('username' in cols) {
      return { from: () => Promise.resolve(usersRows) } as never;
    }
    // Mapping rows query is now scoped with .where(eq(source, 'ombi')) (media_requests
    // generalization) - chainable so buildRequesterResolver's real .from().where() call resolves.
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
// runOmbiSync
// ============================================================================

describe('runOmbiSync', () => {
  it('is a complete no-op when Ombi is not configured', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null });

    const result = await runOmbiSync('scheduled');

    expect(result).toEqual({
      configured: false,
      moviePhase: { ok: true, processed: 0, skipped: 0, pruned: 0, error: null },
      tvPhase: { ok: true, processed: 0, skipped: 0, pruned: 0, error: null },
    });
    expect(OmbiService).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('is a no-op when only one of url/apiKey is set (partial configuration)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: null,
    });

    const result = await runOmbiSync('scheduled');

    expect(result.configured).toBe(false);
    expect(OmbiService).not.toHaveBeenCalled();
  });

  it('upserts both phases and prunes when validation is clean', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetMovieRequests.mockResolvedValue({ records: [movieRecord()], skipped: 0 });
    mockGetTvRequests.mockResolvedValue({ records: [], skipped: 0 });
    const tx = mockTransaction([{ id: 'pruned-1' }]);

    const result = await runOmbiSync('manual');

    expect(result.configured).toBe(true);
    expect(result.moviePhase).toEqual({
      ok: true,
      processed: 1,
      skipped: 0,
      pruned: 1,
      error: null,
    });
    // Zero tv records + allowPrune -> pruned via the top-level db.delete path, not the tx.
    expect(result.tvPhase.ok).toBe(true);
    expect(tx.insert).toHaveBeenCalledTimes(1); // only the movie phase had records to insert
    expect(setSetting).toHaveBeenCalledWith(
      'ombiSyncStatus',
      expect.objectContaining({ lastError: null, skippedValidation: 0 })
    );
  });

  it('suppresses prune when a phase has validation failures (ADR 0004)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetMovieRequests.mockResolvedValue({ records: [movieRecord()], skipped: 3 });
    mockGetTvRequests.mockResolvedValue({ records: [], skipped: 0 });
    const tx = mockTransaction([{ id: 'should-not-be-counted' }]);

    const result = await runOmbiSync('scheduled');

    expect(result.moviePhase.skipped).toBe(3);
    expect(result.moviePhase.pruned).toBe(0); // prune suppressed
    expect(tx.delete).not.toHaveBeenCalled(); // never even attempted
  });

  it('keeps the movie phase intact when the TV phase fails (phase independence)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetMovieRequests.mockResolvedValue({ records: [movieRecord()], skipped: 0 });
    mockGetTvRequests.mockRejectedValue(new Error('Ombi API error: 500 Internal Server Error'));
    mockTransaction([{ id: 'pruned-movie-1' }]);

    const result = await runOmbiSync('scheduled');

    expect(result.moviePhase).toEqual({
      ok: true,
      processed: 1,
      skipped: 0,
      pruned: 1,
      error: null,
    });
    expect(result.tvPhase.ok).toBe(false);
    expect(result.tvPhase.error).toContain('500');
    expect(setSetting).toHaveBeenCalledWith(
      'ombiSyncStatus',
      expect.objectContaining({ lastError: expect.stringContaining('500') })
    );
  });

  it('redacts the API key from a phase failure message before persisting/logging it (SEERR-04 sibling fix)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'super-secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    mockGetMovieRequests.mockRejectedValue(
      new Error('Ombi API error: 500 super-secret-key-as-reason-phrase')
    );
    mockGetTvRequests.mockResolvedValue({ records: [], skipped: 0 });
    mockRedact.mockImplementationOnce((message: string) =>
      message.split('super-secret-key').join('<redacted>')
    );

    const result = await runOmbiSync('scheduled');

    expect(mockRedact).toHaveBeenCalledWith(
      expect.stringContaining('super-secret-key-as-reason-phrase')
    );
    expect(result.moviePhase.error).not.toContain('super-secret-key');
    expect(result.moviePhase.error).toContain('<redacted>');
  });

  it('chunks the insert into batches of 1000 rows to stay under the bind-parameter limit (CR-3 sibling fix)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    const records = Array.from({ length: 1500 }, (_, i) => movieRecord({ ombiRequestId: i + 1 }));
    mockGetMovieRequests.mockResolvedValue({ records, skipped: 0 });
    mockGetTvRequests.mockResolvedValue({ records: [], skipped: 0 });
    const tx = mockTransaction([]);

    const result = await runOmbiSync('manual');

    expect(result.moviePhase.processed).toBe(1500);
    expect(tx.insert).toHaveBeenCalledTimes(2); // 1500 / 1000-row chunks
    const firstChunk = (tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      .values.mock.calls[0]?.[0] as unknown[];
    const secondChunk = (tx.insert.mock.results[1]?.value as { values: ReturnType<typeof vi.fn> })
      .values.mock.calls[0]?.[0] as unknown[];
    expect(firstChunk).toHaveLength(1000);
    expect(secondChunk).toHaveLength(500);
  });

  it('preserves the previous lastSuccessAt when the run fails', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://localhost:5420',
      ombiApiKey: 'secret-key',
    });
    const previous: OmbiSyncStatusInternal = {
      lastRunAt: '2025-01-01T00:00:00.000Z',
      lastSuccessAt: '2025-01-01T00:00:00.000Z',
      lastError: null,
      skippedValidation: 0,
      moviePhaseOk: true,
      tvPhaseOk: true,
    };
    vi.mocked(getSetting).mockResolvedValue(previous);
    mockGetMovieRequests.mockRejectedValue(new Error('network down'));
    mockGetTvRequests.mockRejectedValue(new Error('network down'));

    await runOmbiSync('scheduled');

    expect(setSetting).toHaveBeenCalledWith(
      'ombiSyncStatus',
      expect.objectContaining({
        lastSuccessAt: '2025-01-01T00:00:00.000Z',
        lastError: 'network down',
      })
    );
  });

  it('reports an error and does not fetch when OmbiService construction throws (e.g. SSRF)', async () => {
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://169.254.169.254',
      ombiApiKey: 'secret-key',
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(OmbiService).mockImplementationOnce(function () {
      throw new Error('169.254.169.254 is in the link-local range');
    });

    const result = await runOmbiSync('scheduled');

    expect(result.moviePhase.error).toContain('link-local');
    expect(mockGetMovieRequests).not.toHaveBeenCalled();
    expect(mockGetTvRequests).not.toHaveBeenCalled();
  });
});

// ============================================================================
// buildRequesterResolver - ADR 0002 pipeline
// ============================================================================

describe('buildRequesterResolver', () => {
  it('resolves via case-insensitive username match', async () => {
    mockResolverQueries({ usersRows: [{ id: 'user-1', username: 'Alice' }] });

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'alice',
      ombiAlias: null,
      providerUserId: null,
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

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'Shared',
      ombiAlias: null,
      providerUserId: null,
    });

    expect(result).toEqual({ userId: null, matchMethod: null });
  });

  it('manual override wins over an available username match', async () => {
    mockResolverQueries({
      mappings: [{ ombiUserId: 'ombi-1', userId: 'user-override' }],
      usersRows: [{ id: 'user-1', username: 'alice' }],
    });

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'alice',
      ombiAlias: null,
      providerUserId: null,
    });

    expect(result).toEqual({ userId: 'user-override', matchMethod: 'manual' });
  });

  it('a manual override with userId=null forces unattributed even with a username match available', async () => {
    mockResolverQueries({
      mappings: [{ ombiUserId: 'ombi-1', userId: null }],
      usersRows: [{ id: 'user-1', username: 'alice' }],
    });

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'alice',
      ombiAlias: null,
      providerUserId: null,
    });

    expect(result).toEqual({ userId: null, matchMethod: 'manual' });
  });

  it('resolves via providerUserId when present and no manual override exists', async () => {
    mockResolverQueries({
      serverUsersRows: [{ plexAccountId: 'plex-abc', userId: 'user-2' }],
    });

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'nomatch',
      ombiAlias: null,
      providerUserId: 'plex-abc',
    });

    expect(result).toEqual({ userId: 'user-2', matchMethod: 'provider' });
  });

  it('falls through to unattributed with no manual/provider/username match', async () => {
    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'nobody',
      ombiAlias: null,
      providerUserId: null,
    });

    expect(result).toEqual({ userId: null, matchMethod: null });
  });

  it('skips the provider tier when providerUserId is null (live re-resolution path)', async () => {
    mockResolverQueries({
      serverUsersRows: [{ plexAccountId: 'plex-abc', userId: 'user-2' }],
      usersRows: [{ id: 'user-3', username: 'bob' }],
    });

    const resolver = await buildRequesterResolver();
    const result = resolver.resolve({
      ombiUserId: 'ombi-1',
      ombiUsername: 'bob',
      ombiAlias: null,
      providerUserId: null, // never persisted - routes/ombi.ts always passes null
    });

    expect(result).toEqual({ userId: 'user-3', matchMethod: 'username' });
  });
});

// ============================================================================
// invalidateOmbiCaches
// ============================================================================

describe('invalidateOmbiCaches', () => {
  it('deletes all keys matching the library:stale and ombi:requester-stats patterns', async () => {
    const keys = vi.fn((pattern: string) => {
      if (pattern.includes('stale')) return Promise.resolve(['stale:a', 'stale:b']);
      if (pattern.includes('requester-stats')) return Promise.resolve(['stats:a']);
      return Promise.resolve([]);
    });
    const del = vi.fn().mockResolvedValue(3);
    const redis = { keys, del } as unknown as Redis;

    await invalidateOmbiCaches(redis);

    expect(del).toHaveBeenCalledWith('stale:a', 'stale:b');
    expect(del).toHaveBeenCalledWith('stats:a');
  });

  it('is a no-op when no matching keys exist', async () => {
    const keys = vi.fn().mockResolvedValue([]);
    const del = vi.fn();
    const redis = { keys, del } as unknown as Redis;

    await invalidateOmbiCaches(redis);

    expect(del).not.toHaveBeenCalled();
  });
});
