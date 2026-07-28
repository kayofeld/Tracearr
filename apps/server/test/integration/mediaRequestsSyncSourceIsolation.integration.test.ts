/**
 * Sync-time source isolation on the shared media_requests table (real Postgres).
 *
 * Runs the REAL upsert + prune SQL of runSeerrSync (jobs/seerrSyncQueue.ts) and
 * runOmbiSync (jobs/ombiSyncQueue.ts) against a migrated database seeded with
 * rows from BOTH sources - the unit suites mock the db and only assert the
 * drizzle call shapes, so the actual DELETE scoping (ADR 0004 §5 / ADR 0006:
 * "prune is scoped to its own source") has never executed anywhere with a
 * foreign source's rows at risk.
 *
 * Covers (acceptance criteria 2):
 * - A Seerr full-mirror prune deletes ONLY stale seerr rows; ombi rows with an
 *   older synced_at survive untouched (and vice versa for Ombi's per-mediaType
 *   prune).
 * - The composite (source, media_type, source_request_id) upsert key: a seerr
 *   record whose source id collides with an existing ombi row UPDATES its own
 *   seerr row and never clobbers the ombi twin.
 *
 * The HTTP clients and settings are mocked (they only feed records in); db is
 * real. Redis/BullMQ are untouched (queues are never initialized here, so the
 * cache-invalidation branch is skipped by design).
 *
 * Run with:
 *   pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts mediaRequestsSyncSourceIsolation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFetchAllRequests = vi.fn();
const mockGetRequestCount = vi.fn();
const mockGetMovieRequests = vi.fn();
const mockGetTvRequests = vi.fn();

vi.mock('../../src/services/seerr.js', () => ({
  SeerrService: vi.fn().mockImplementation(function () {
    return { fetchAllRequests: mockFetchAllRequests, getRequestCount: mockGetRequestCount };
  }),
}));

vi.mock('../../src/services/ombi.js', () => ({
  OmbiService: vi.fn().mockImplementation(function () {
    return { getMovieRequests: mockGetMovieRequests, getTvRequests: mockGetTvRequests };
  }),
}));

vi.mock('../../src/services/settings.js', () => ({
  getSeerrSettings: vi.fn(),
  getOmbiSettings: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { mediaRequests } from '../../src/db/schema.js';
import { getSeerrSettings, getOmbiSettings, getSetting } from '../../src/services/settings.js';
import { runSeerrSync } from '../../src/jobs/seerrSyncQueue.js';
import { runOmbiSync } from '../../src/jobs/ombiSyncQueue.js';
import type { SeerrSyncRecord } from '../../src/services/seerr.js';
import type { OmbiSyncRecord } from '../../src/services/ombi.js';

/** synced_at older than any run started in this test file. */
const STALE_SYNCED_AT = new Date('2020-01-01T00:00:00.000Z');

function seerrRecord(overrides: Partial<SeerrSyncRecord> = {}): SeerrSyncRecord {
  return {
    seerrRequestId: 501,
    mediaType: 'movie',
    title: null,
    releaseYear: null,
    imdbId: null,
    tmdbId: 90001,
    tvdbId: null,
    seasons: null,
    is4k: false,
    status: 'approved',
    requestedAt: new Date('2025-01-01T00:00:00.000Z'),
    availableAt: null,
    requester: {
      seerrUserId: '17',
      seerrUsername: 'alice_seerr',
      seerrAlias: null,
      externalUserId: null,
    },
    ...overrides,
  };
}

function ombiRecord(overrides: Partial<OmbiSyncRecord> = {}): OmbiSyncRecord {
  return {
    ombiRequestId: 601,
    ombiParentRequestId: null,
    mediaType: 'movie',
    title: 'An Ombi Movie',
    releaseYear: 2020,
    imdbId: null,
    tmdbId: 90002,
    tvdbId: null,
    seasons: null,
    is4k: false,
    status: 'available',
    requestedAt: new Date('2025-02-01T00:00:00.000Z'),
    availableAt: null,
    requester: {
      ombiUserId: 'ombi-guid-1',
      ombiUsername: 'alice_ombi',
      ombiAlias: null,
      providerUserId: null,
    },
    ...overrides,
  };
}

/** Seed one stale row per source plus a seerr/ombi pair sharing source_request_id. */
async function seedBothSources() {
  await db.insert(mediaRequests).values([
    {
      source: 'ombi',
      sourceRequestId: 601,
      mediaType: 'movie',
      title: 'An Ombi Movie',
      tmdbId: 90002,
      status: 'pending',
      requestedAt: new Date('2025-02-01T00:00:00.000Z'),
      sourceUserId: 'ombi-guid-1',
      sourceUsername: 'alice_ombi',
      userId: null,
      matchMethod: null,
      syncedAt: STALE_SYNCED_AT,
    },
    {
      // Deliberately shares sourceRequestId=501 with the seerr row below.
      source: 'ombi',
      sourceRequestId: 501,
      mediaType: 'movie',
      title: 'Ombi Twin Of Seerr 501',
      tmdbId: 90003,
      status: 'available',
      requestedAt: new Date('2025-03-01T00:00:00.000Z'),
      sourceUserId: 'ombi-guid-2',
      sourceUsername: 'bob_ombi',
      userId: null,
      matchMethod: null,
      syncedAt: STALE_SYNCED_AT,
    },
    {
      source: 'seerr',
      sourceRequestId: 501,
      mediaType: 'movie',
      title: null,
      tmdbId: 90001,
      status: 'pending',
      requestedAt: new Date('2025-01-01T00:00:00.000Z'),
      sourceUserId: '17',
      sourceUsername: 'alice_seerr',
      userId: null,
      matchMethod: null,
      syncedAt: STALE_SYNCED_AT,
    },
    {
      // A seerr row the next Seerr run no longer returns - MUST be pruned.
      source: 'seerr',
      sourceRequestId: 502,
      mediaType: 'movie',
      title: null,
      tmdbId: 90004,
      status: 'pending',
      requestedAt: new Date('2025-01-02T00:00:00.000Z'),
      sourceUserId: '17',
      sourceUsername: 'alice_seerr',
      userId: null,
      matchMethod: null,
      syncedAt: STALE_SYNCED_AT,
    },
  ]);
}

async function rowsBySource(source: 'ombi' | 'seerr') {
  return db
    .select({
      sourceRequestId: mediaRequests.sourceRequestId,
      mediaType: mediaRequests.mediaType,
      title: mediaRequests.title,
      status: mediaRequests.status,
      tmdbId: mediaRequests.tmdbId,
    })
    .from(mediaRequests)
    .where(eq(mediaRequests.source, source))
    .orderBy(mediaRequests.sourceRequestId);
}

describe('sync-time source isolation on media_requests (real Postgres)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    // beforeEach DB reset comes from the shared integration setup; media_requests
    // is cascade-truncated with users. Belt and braces:
    await db.delete(mediaRequests);
  });

  it('a Seerr sync prunes only stale seerr rows - every ombi row survives with older synced_at', async () => {
    await seedBothSources();
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://seerr.local',
      seerrApiKey: 'key',
    });
    mockGetRequestCount.mockRejectedValue(new Error('count endpoint down (non-fatal)'));
    // The run returns ONLY request 501 - 502 is gone from Seerr and prunable.
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord({ seerrRequestId: 501, status: 'available' })],
      skipped: 0,
      paginationConsistent: true,
    });

    const result = await runSeerrSync('manual');

    expect(result.configured).toBe(true);
    expect(result.phase.ok).toBe(true);
    expect(result.phase.processed).toBe(1);
    expect(result.phase.pruned).toBe(1); // exactly seerr 502, nothing else

    const seerrRows = await rowsBySource('seerr');
    expect(seerrRows).toHaveLength(1);
    expect(seerrRows[0]).toMatchObject({
      sourceRequestId: 501,
      status: 'available', // upserted by the run
    });

    // BOTH ombi rows survive despite synced_at long before runStartedAt -
    // including the twin sharing sourceRequestId=501, whose title/status are untouched.
    const ombiRows = await rowsBySource('ombi');
    expect(ombiRows).toHaveLength(2);
    expect(ombiRows.find((r) => r.sourceRequestId === 501)).toMatchObject({
      title: 'Ombi Twin Of Seerr 501',
      status: 'available',
      tmdbId: 90003,
    });
    expect(ombiRows.find((r) => r.sourceRequestId === 601)).toMatchObject({
      title: 'An Ombi Movie',
      status: 'pending',
    });
  });

  it('a Seerr run with prune suppressed (validation failures) still upserts but deletes nothing', async () => {
    await seedBothSources();
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://seerr.local',
      seerrApiKey: 'key',
    });
    mockGetRequestCount.mockRejectedValue(new Error('non-fatal'));
    mockFetchAllRequests.mockResolvedValue({
      records: [seerrRecord({ seerrRequestId: 501 })],
      skipped: 1, // one malformed record -> prune must be suppressed
      paginationConsistent: true,
    });

    const result = await runSeerrSync('manual');

    expect(result.phase.ok).toBe(true);
    expect(result.phase.pruned).toBe(0);
    // Stale seerr row 502 SURVIVES this run (self-heals next clean run).
    const seerrRows = await rowsBySource('seerr');
    expect(seerrRows.map((r) => r.sourceRequestId)).toEqual([501, 502]);
    expect((await rowsBySource('ombi')).length).toBe(2);
  });

  it('an Ombi sync prunes only stale ombi rows of the synced mediaType - every seerr row survives', async () => {
    await seedBothSources();
    vi.mocked(getOmbiSettings).mockResolvedValue({
      ombiUrl: 'http://ombi.local',
      ombiApiKey: 'key',
    });
    // The run returns ONLY movie request 601 - ombi movie 501 (the twin) is
    // gone from Ombi and prunable. No TV requests at all.
    mockGetMovieRequests.mockResolvedValue({
      records: [ombiRecord({ ombiRequestId: 601, status: 'approved' })],
      skipped: 0,
    });
    mockGetTvRequests.mockResolvedValue({ records: [], skipped: 0 });

    const result = await runOmbiSync('manual');

    expect(result.configured).toBe(true);
    expect(result.moviePhase.ok).toBe(true);
    expect(result.moviePhase.pruned).toBe(1); // exactly ombi movie 501

    const ombiRows = await rowsBySource('ombi');
    expect(ombiRows).toHaveLength(1);
    expect(ombiRows[0]).toMatchObject({ sourceRequestId: 601, status: 'approved' });

    // BOTH seerr rows survive the Ombi prune, stale synced_at and all.
    const seerrRows = await rowsBySource('seerr');
    expect(seerrRows.map((r) => r.sourceRequestId)).toEqual([501, 502]);
  });

  it('an unconfigured connector is a complete no-op against the database', async () => {
    await seedBothSources();
    vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });
    vi.mocked(getOmbiSettings).mockResolvedValue({ ombiUrl: null, ombiApiKey: null });

    const seerrResult = await runSeerrSync('scheduled');
    const ombiResult = await runOmbiSync('scheduled');

    expect(seerrResult.configured).toBe(false);
    expect(ombiResult.configured).toBe(false);
    // Nothing upserted, nothing pruned, nothing touched.
    expect((await rowsBySource('ombi')).length).toBe(2);
    expect((await rowsBySource('seerr')).length).toBe(2);
  });
});
