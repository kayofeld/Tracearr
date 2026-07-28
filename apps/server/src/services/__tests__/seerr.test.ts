/**
 * Seerr API client tests
 *
 * Covers constructor validation (incl. SSRF), the two-call test-connection
 * probe (success / auth-failure / HTML body / status-endpoint-unauthenticated-
 * but-key-invalid), paginated request fetch/mapping with per-record
 * validation skip, pagination safety (multi-page, short final page, dedupe,
 * hard cap, consistency flag gating prune), and that the API key never
 * appears in a returned/logged string (ADR 0005).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SeerrService,
  SeerrAuthError,
  SeerrInvalidResponseError,
  SEERR_MAX_RETRIES,
  SEERR_TEST_CONNECTION_TIMEOUT_MS,
  SEERR_PAGE_SIZE,
} from '../seerr.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    type: 'default',
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  };
}

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    type: 'default',
    headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  };
}

function pageInfo(
  overrides: Partial<{ pages: number; pageSize: number; results: number; page: number }> = {}
) {
  return { pages: 1, pageSize: SEERR_PAGE_SIZE, results: 0, page: 1, ...overrides };
}

const validRequest = {
  id: 101,
  status: 5,
  type: 'movie' as const,
  is4k: false,
  createdAt: '2025-03-03T09:07:45.310Z',
  media: {
    tmdbId: 42,
    tvdbId: null,
    imdbId: 'tt1234567',
    mediaAddedAt: '2025-03-04T00:00:00Z',
  },
  requestedBy: {
    id: 7,
    jellyfinUserId: 'jf-user-guid-1',
    jellyfinUsername: 'lukelino',
    displayName: 'Luke L.',
    email: 'luke@example.com',
    userType: 1,
    username: null,
    plexUsername: null,
    plexId: null,
  },
  seasons: null,
};

describe('SeerrService constructor', () => {
  it('throws for a link-local (SSRF-blocked) URL', () => {
    expect(() => new SeerrService('http://169.254.169.254', 'key')).toThrow(/link-local/);
  });

  it('allows loopback (Tracearr probes local network services by design)', () => {
    expect(() => new SeerrService('http://localhost:5055', 'key')).not.toThrow();
  });

  it('allows RFC1918 addresses', () => {
    expect(() => new SeerrService('http://192.168.1.50:5055', 'key')).not.toThrow();
  });

  it('throws for a malformed URL', () => {
    expect(() => new SeerrService('not-a-url', 'key')).toThrow(/Malformed URL/);
  });

  it('throws for an empty API key', () => {
    expect(() => new SeerrService('http://localhost:5055', '')).toThrow(
      'Seerr API key is required'
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(pageInfo()));
    global.fetch = mockFetch as typeof global.fetch;

    const service = new SeerrService('http://localhost:5055/', 'key');
    await service.getRequestCount().catch(() => undefined); // shape mismatch is fine, only checking the URL

    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://localhost:5055/api/v1/request/count');
  });
});

describe('SeerrService.testConnection', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  it('sends the API key via the X-Api-Key header, never as a query param', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ version: '3.4.0' }))
      .mockResolvedValueOnce(jsonResponse({ pageInfo: pageInfo({ results: 46 }), results: [] }));

    const service = new SeerrService('http://localhost:5055', 'super-secret-key');
    await service.testConnection();

    const [url, init] = mockFetch.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(url).not.toContain('super-secret-key');
    expect(init.headers['X-Api-Key']).toBe('super-secret-key');
  });

  it('returns success with version (from /status) and userCount (from /user)', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ version: '3.4.0', commitTag: 'abc123' }))
      .mockResolvedValueOnce(jsonResponse({ pageInfo: pageInfo({ results: 46 }), results: [{}] }));

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({ success: true, version: '3.4.0', userCount: 46 });
  });

  it('classifies a 401 on the reachability call (/status) as an auth failure', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({ success: false, error: 'Invalid Seerr API key' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retries, and never reaches the second call
  });

  it('classifies a 401 on the key-validity call (/user) as an auth failure - the two-call design (contract §2)', async () => {
    // /status succeeds WITHOUT the key being valid (typically unauthenticated
    // in this lineage) - only /user validates the key.
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ version: '3.4.0' }))
      .mockResolvedValueOnce(jsonResponse({}, 401));

    const service = new SeerrService('http://localhost:5055', 'wrong-key');
    const result = await service.testConnection();

    // version is present ONLY on overall success (contract §2) - even though
    // /status succeeded and returned one, the failed /user call means the
    // response must not include it.
    expect(result).toEqual({ success: false, error: 'Invalid Seerr API key' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('classifies an HTML SPA-fallback body as an invalid response, not a crash', async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse());

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-JSON/);
  });

  it('classifies a network error on /status without retry (maxRetries=1)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a /user response whose shape is not the expected paginated format', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ version: '3.4.0' }))
      .mockResolvedValueOnce(jsonResponse({ notPaginated: true }));

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({
      success: false,
      error: 'Seerr returned an unexpected response format',
    });
  });

  it('never lets the API key leak into the returned error string', async () => {
    const apiKey = 'leaky-secret-abc123';
    mockFetch.mockRejectedValueOnce(new Error(`fetch failed for url containing ${apiKey}`));

    const service = new SeerrService('http://localhost:5055', apiKey);
    const result = await service.testConnection();

    expect(result.error).not.toContain(apiKey);
    expect(result.error).toContain('<redacted>');
  });

  it('succeeds even when /status returns a non-JSON body (best-effort - version simply lost)', async () => {
    // Contract §2 only requires reachability for /status; a genuinely broken
    // /status should still fail reachability though - this covers the case
    // where /status parses but lacks a recognizable version field.
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ unexpectedShape: true }))
      .mockResolvedValueOnce(jsonResponse({ pageInfo: pageInfo({ results: 5 }), results: [{}] }));

    const service = new SeerrService('http://localhost:5055', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({ success: true, version: undefined, userCount: 5 });
  });
});

describe('SeerrService.getRequestCount', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as typeof global.fetch;
  });

  it('validates and returns the count payload', async () => {
    const countPayload = {
      total: 108,
      movie: 65,
      tv: 43,
      pending: 0,
      approved: 106,
      declined: 0,
      processing: 0,
      available: 2,
      completed: 0,
    };
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse(countPayload) as never);

    const service = new SeerrService('http://localhost:5055', 'key');
    const result = await service.getRequestCount();

    expect(result).toEqual(countPayload);
  });

  it('throws SeerrInvalidResponseError when the shape does not match', async () => {
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ total: 'not a number' }) as never);

    const service = new SeerrService('http://localhost:5055', 'key');
    await expect(service.getRequestCount()).rejects.toBeInstanceOf(SeerrInvalidResponseError);
  });
});

describe('SeerrService.fetchAllRequests', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  it('maps a valid movie record to the internal sync shape', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [validRequest] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped, paginationConsistent } = await service.fetchAllRequests();

    expect(skipped).toBe(0);
    expect(paginationConsistent).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      seerrRequestId: 101,
      mediaType: 'movie',
      title: null,
      releaseYear: null,
      imdbId: 'tt1234567',
      tmdbId: 42,
      tvdbId: null,
      is4k: false,
      status: 'available', // status=5
      requester: {
        seerrUserId: '7',
        seerrUsername: 'lukelino', // jellyfinUsername preferred
        seerrAlias: 'Luke L.',
        externalUserId: 'jf-user-guid-1', // jellyfinUserId preferred over plexId
      },
    });
    expect(records[0]?.requestedAt.toISOString()).toBe('2025-03-03T09:07:45.310Z');
  });

  it('falls back to plexId when jellyfinUserId is absent (Plex-backed Seerr)', async () => {
    const plexRequest = {
      ...validRequest,
      id: 102,
      requestedBy: {
        ...validRequest.requestedBy,
        jellyfinUserId: null,
        jellyfinUsername: null,
        username: 'plexlover',
        plexUsername: 'plexlover',
        plexId: 'plex-account-123',
      },
    };
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [plexRequest] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records } = await service.fetchAllRequests();

    expect(records[0]?.requester).toEqual({
      seerrUserId: '7',
      seerrUsername: 'plexlover', // plexUsername preferred over bare username
      seerrAlias: 'Luke L.',
      externalUserId: 'plex-account-123',
    });
  });

  it('derives status from the integer vocabulary (1=pending,2=approved,3=denied,4=approved/processing,5=available)', async () => {
    const requests = [1, 2, 3, 4, 5].map((status, i) => ({
      ...validRequest,
      id: 200 + i,
      status,
    }));
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: requests.length }), results: requests })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records } = await service.fetchAllRequests();

    expect(records.map((r) => r.status)).toEqual([
      'pending',
      'approved',
      'denied',
      'approved', // processing folds into approved
      'available',
    ]);
  });

  it('defaults an unrecognized status integer to pending and warns, without skipping the record', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(
      jsonResponse({
        pageInfo: pageInfo({ results: 1 }),
        results: [{ ...validRequest, id: 300, status: 99 }],
      })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped } = await service.fetchAllRequests();

    expect(skipped).toBe(0);
    expect(records[0]?.status).toBe('pending');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown status 99'));
    warnSpy.mockRestore();
  });

  it('carries tv seasons but not for movies', async () => {
    const tvRequest = {
      ...validRequest,
      id: 400,
      type: 'tv' as const,
      media: { ...validRequest.media, tmdbId: null, tvdbId: 12345 },
      seasons: [
        { id: 1, seasonNumber: 1, status: 2, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        { id: 2, seasonNumber: 2, status: 2, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
      ],
    };
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [tvRequest] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records } = await service.fetchAllRequests();

    expect(records[0]?.mediaType).toBe('tv');
    expect(records[0]?.seasons).toEqual([1, 2]);
    expect(records[0]?.tvdbId).toBe(12345);
  });

  it('skips a malformed record and keeps processing valid ones (never fails the whole run)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        pageInfo: pageInfo({ results: 2 }),
        results: [validRequest, { id: 999 /* missing required fields */ }],
      })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped, paginationConsistent } = await service.fetchAllRequests();

    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
    // Still consistent: 1 valid + 1 skipped = 2, matching pageInfo.results.
    expect(paginationConsistent).toBe(true);
  });

  it('skips a record with an over-long imdbId rather than truncating a join key (SEC-05)', async () => {
    const bad = {
      ...validRequest,
      media: { ...validRequest.media, imdbId: 'tt' + '1'.repeat(30) },
    };
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [bad] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped } = await service.fetchAllRequests();

    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('skips a record with an over-long jellyfinUserId rather than truncating the primary match key (SEC-05)', async () => {
    const bad = {
      ...validRequest,
      requestedBy: { ...validRequest.requestedBy, jellyfinUserId: 'x'.repeat(100) },
    };
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [bad] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped } = await service.fetchAllRequests();

    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('truncates an over-long display name instead of skipping the record (SEC-05)', async () => {
    const longName = 'A'.repeat(600);
    const bad = {
      ...validRequest,
      requestedBy: { ...validRequest.requestedBy, displayName: longName },
    };
    mockFetch.mockResolvedValue(
      jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [bad] })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped } = await service.fetchAllRequests();

    expect(skipped).toBe(0);
    expect(records[0]?.requester.seerrAlias).toBe('A'.repeat(255));
  });

  // ==========================================================================
  // Pagination safety (design §6)
  // ==========================================================================

  it('walks multiple pages and stops on a short final page', async () => {
    const page1Results = Array.from({ length: 100 }, (_, i) => ({ ...validRequest, id: i + 1 }));
    const page2Results = Array.from({ length: 8 }, (_, i) => ({ ...validRequest, id: 101 + i }));
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ pageInfo: pageInfo({ results: 108, page: 1 }), results: page1Results })
      )
      .mockResolvedValueOnce(
        jsonResponse({ pageInfo: pageInfo({ results: 108, page: 2 }), results: page2Results })
      );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, skipped, paginationConsistent } = await service.fetchAllRequests();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[0]).toContain('skip=0');
    expect(mockFetch.mock.calls[1]?.[0]).toContain('skip=100');
    expect(records).toHaveLength(108);
    expect(skipped).toBe(0);
    expect(paginationConsistent).toBe(true);
  });

  it('stops immediately when the first page is already empty (zero requests today)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ pageInfo: pageInfo({ results: 0 }), results: [] }));

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records, paginationConsistent } = await service.fetchAllRequests();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(0);
    expect(paginationConsistent).toBe(true);
  });

  it('dedupes a record that reappears across pages (moving-offset artifact)', async () => {
    const dup = { ...validRequest, id: 1 };
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ pageInfo: pageInfo({ results: 3, page: 1 }), results: [dup, dup] })
      )
      .mockResolvedValueOnce(
        // Second call requests skip=SEERR_PAGE_SIZE (100); `skip + results.length`
        // (100+1=101) exceeds the reported total (3), so the loop stops here
        // regardless of the small `results` arrays used in this fixture.
        jsonResponse({
          pageInfo: pageInfo({ results: 3, page: 2 }),
          results: [{ ...validRequest, id: 2 }],
        })
      );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { records } = await service.fetchAllRequests();

    // Same id (1) appears twice across the two calls' first page - deduped to one.
    expect(records.map((r) => r.seerrRequestId).sort()).toEqual([1, 2]);
  });

  it('marks pagination inconsistent and stops when the hard page cap is hit (pathological pageInfo.results)', async () => {
    // pageInfo.results claims 100000 but every page returns 0 new items after
    // the first - forces the hard-cap guard to trip rather than looping forever.
    mockFetch.mockResolvedValue(
      jsonResponse({
        pageInfo: pageInfo({ results: 100_000, page: 1 }),
        results: [validRequest], // 1 result per page, never reaching the reported total
      })
    );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { paginationConsistent } = await service.fetchAllRequests();

    expect(paginationConsistent).toBe(false);
    // Hard cap = ceil(100000/100)+1 = 1001 - bounded, not infinite.
    expect(mockFetch).toHaveBeenCalledTimes(1001);
  });

  it('marks pagination inconsistent when the reported total drops mid-pagination (concurrent Seerr write - design §6 step 6)', async () => {
    // Page 1 reports a total of 3 with only 2 items on this page (not done
    // yet, so the loop fetches a second page). Page 2 reports a LOWER total
    // (2) - as if a request was deleted in Seerr between the two calls - so
    // the final reported total (2) doesn't match everything actually
    // collected across both pages (3). This is exactly the pagination-vs-
    // concurrent-write race the consistency guard exists to catch.
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          pageInfo: pageInfo({ results: 3, page: 1 }),
          results: [
            { ...validRequest, id: 1 },
            { ...validRequest, id: 2 },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pageInfo: pageInfo({ results: 2, page: 2 }),
          results: [{ ...validRequest, id: 3 }],
        })
      );

    const service = new SeerrService('http://localhost:5055', 'key');
    const { paginationConsistent, skipped, records } = await service.fetchAllRequests();

    expect(records).toHaveLength(3);
    expect(skipped).toBe(0);
    // processed (3) !== the LAST page's reported total (2)
    expect(paginationConsistent).toBe(false);
  });

  it('throws SeerrInvalidResponseError when the top-level payload is not the paginated shape (HTML fallback)', async () => {
    mockFetch.mockResolvedValue(htmlResponse());

    const service = new SeerrService('http://localhost:5055', 'key');
    await expect(service.fetchAllRequests()).rejects.toBeInstanceOf(SeerrInvalidResponseError);
  });

  it('throws SeerrAuthError on a 401 without retrying', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401));

    const service = new SeerrService('http://localhost:5055', 'key');
    await expect(service.fetchAllRequests()).rejects.toBeInstanceOf(SeerrAuthError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it(`retries up to ${SEERR_MAX_RETRIES} times on a transient failure, then succeeds`, async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(
          jsonResponse({ pageInfo: pageInfo({ results: 1 }), results: [validRequest] })
        );

      const service = new SeerrService('http://localhost:5055', 'key');
      const promise = service.fetchAllRequests();
      await vi.advanceTimersByTimeAsync(1500);
      const result = await promise;

      expect(result.records).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends redirect: manual so a 30x from Seerr is never followed (SEC-02)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ pageInfo: pageInfo({ results: 0 }), results: [] }));

    const service = new SeerrService('http://localhost:5055', 'key');
    await service.fetchAllRequests();

    const [, init] = mockFetch.mock.calls[0] as [string, { redirect: string }];
    expect(init.redirect).toBe('manual');
  });

  it('rejects a response whose Content-Length exceeds the size cap without retrying (SEC-03)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      type: 'default',
      headers: {
        get: (name: string) =>
          name === 'content-length'
            ? String(60 * 1024 * 1024)
            : name === 'content-type'
              ? 'application/json'
              : null,
      },
      json: async () => ({ pageInfo: pageInfo({ results: 0 }), results: [] }),
    });

    const service = new SeerrService('http://localhost:5055', 'key');
    await expect(service.fetchAllRequests()).rejects.toBeInstanceOf(SeerrInvalidResponseError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the abort timer armed through response.json() so a hanging body times out instead of buffering forever (SEC-03)', async () => {
    vi.useFakeTimers();
    try {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          type: 'default',
          headers: {
            get: (name: string) => (name === 'content-type' ? 'application/json' : null),
          },
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        });
      });

      const service = new SeerrService('http://localhost:5055', 'key');
      const promise = service.testConnection();
      await vi.advanceTimersByTimeAsync(SEERR_TEST_CONNECTION_TIMEOUT_MS + 1_000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
