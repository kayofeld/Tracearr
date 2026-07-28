/**
 * Ombi API client tests
 *
 * Covers constructor validation (incl. SSRF), test-connection success/auth-
 * failure/non-JSON(HTML)-body/network-error, movie + TV request fetch/mapping
 * with per-record validation skip (never fails the whole run), TV parent-vs-
 * child validation independence, retry behavior, and that the API key never
 * appears in a returned/logged string (ADR 0005).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OmbiService,
  OmbiAuthError,
  OmbiInvalidResponseError,
  OMBI_MAX_RETRIES,
  OMBI_TEST_CONNECTION_TIMEOUT_MS,
} from '../ombi.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  };
}

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  };
}

describe('OmbiService constructor', () => {
  it('throws for a link-local (SSRF-blocked) URL', () => {
    expect(() => new OmbiService('http://169.254.169.254', 'key')).toThrow(/link-local/);
  });

  it('allows loopback (Tracearr probes local network services by design)', () => {
    expect(() => new OmbiService('http://localhost:5420', 'key')).not.toThrow();
  });

  it('allows RFC1918 addresses', () => {
    expect(() => new OmbiService('http://192.168.1.50:5420', 'key')).not.toThrow();
  });

  it('throws for a malformed URL', () => {
    expect(() => new OmbiService('not-a-url', 'key')).toThrow(/Malformed URL/);
  });

  it('throws for an empty API key', () => {
    expect(() => new OmbiService('http://localhost:5420', '')).toThrow('Ombi API key is required');
  });

  it('strips a trailing slash from the base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    global.fetch = mockFetch as typeof global.fetch;

    const service = new OmbiService('http://localhost:5420/', 'key');
    await service.testConnection();

    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://localhost:5420/api/v1/Identity/Users');
  });
});

describe('OmbiService.testConnection', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  it('returns success with the counted user payload', async () => {
    mockFetch.mockResolvedValue(jsonResponse([{ id: '1' }, { id: '2' }, { id: '3' }]));

    const service = new OmbiService('http://localhost:5420', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({ success: true, userCount: 3 });
  });

  it('sends the API key via the ApiKey header, never as a query param', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));

    const service = new OmbiService('http://localhost:5420', 'super-secret-key');
    await service.testConnection();

    const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).not.toContain('super-secret-key');
    expect(init.headers.ApiKey).toBe('super-secret-key');
  });

  it('classifies a 401 as an invalid API key, redacted and without retry', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401));

    const service = new OmbiService('http://localhost:5420', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({ success: false, error: 'Invalid Ombi API key' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retries on auth failure
  });

  it('classifies an HTML SPA-fallback body as an invalid response, not a crash', async () => {
    mockFetch.mockResolvedValue(htmlResponse());

    const service = new OmbiService('http://localhost:5420', 'test-key');
    const result = await service.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-JSON/);
  });

  it('classifies a network error without retry (test-connection uses maxRetries=1)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const service = new OmbiService('http://localhost:5420', 'test-key');
    const result = await service.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('never lets the API key leak into the returned error string', async () => {
    const apiKey = 'leaky-secret-abc123';
    mockFetch.mockRejectedValue(new Error(`fetch failed for url containing ${apiKey}`));

    const service = new OmbiService('http://localhost:5420', apiKey);
    const result = await service.testConnection();

    expect(result.error).not.toContain(apiKey);
    expect(result.error).toContain('<redacted>');
  });

  it('rejects a response whose body is not an array', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ notAnArray: true }));

    const service = new OmbiService('http://localhost:5420', 'test-key');
    const result = await service.testConnection();

    expect(result).toEqual({
      success: false,
      error: 'Ombi returned an unexpected response format',
    });
  });

  it('keeps the abort timer armed through response.json() so a hanging body times out instead of buffering forever (SEC-03)', async () => {
    vi.useFakeTimers();
    try {
      // mockFetch's declared type is the generic Mock<Procedure> (return type
      // `any`), so this isn't a real void-context Promise misuse - false
      // positive against vitest's mock typing, same as other test files.
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
              // Body never arrives - only the abort signal can end this.
              init.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        });
      });

      const service = new OmbiService('http://localhost:5420', 'test-key');
      const promise = service.testConnection();
      // Old bug: clearTimeout(timeoutId) ran right after fetch() resolved, so
      // this advance would do nothing and the promise would hang forever.
      await vi.advanceTimersByTimeAsync(OMBI_TEST_CONNECTION_TIMEOUT_MS + 1_000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OmbiService.getMovieRequests', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  const validMovie = {
    id: 101,
    theMovieDbId: 42,
    imdbId: 'tt1234567',
    title: 'How the Grinch Stole Christmas',
    releaseDate: '2000-11-17T00:00:00Z',
    requestedDate: '2025-03-03T09:07:45.3107886Z',
    requestedUser: {
      id: 'ombi-guid-1',
      userName: 'lukelino',
      alias: null,
      email: null,
      userType: 1,
      providerUserId: '',
    },
    requestedByAlias: 'Luke L.',
    approved: true,
    denied: false,
    available: true,
    markedAsAvailable: '2025-03-04T00:00:00Z',
    is4kRequest: false,
  };

  it('maps a valid movie record to the internal sync shape', async () => {
    mockFetch.mockResolvedValue(jsonResponse([validMovie]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getMovieRequests();

    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ombiRequestId: 101,
      ombiParentRequestId: null,
      mediaType: 'movie',
      title: 'How the Grinch Stole Christmas',
      releaseYear: 2000,
      imdbId: 'tt1234567',
      tmdbId: 42,
      tvdbId: null,
      is4k: false,
      status: 'available', // available=true wins precedence
      requester: {
        ombiUserId: 'ombi-guid-1',
        ombiUsername: 'lukelino',
        ombiAlias: 'Luke L.', // requestedUser.alias empty -> falls back to requestedByAlias
        providerUserId: null, // empty string normalized to null
      },
    });
    expect(records[0]?.requestedAt.toISOString()).toBe('2025-03-03T09:07:45.310Z');
  });

  it('treats a blank requestedByAlias as absent instead of persisting an empty string (OMB-1)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        {
          ...validMovie,
          requestedUser: { ...validMovie.requestedUser, alias: null },
          requestedByAlias: '', // Ombi commonly sends this - "" ?? null used to keep ""
        },
      ])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records } = await service.getMovieRequests();

    expect(records[0]?.requester.ombiAlias).toBeNull();
  });

  it('truncates an over-long title to the column width instead of skipping the record (SEC-05)', async () => {
    const longTitle = 'A'.repeat(600);
    mockFetch.mockResolvedValue(jsonResponse([{ ...validMovie, title: longTitle }]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getMovieRequests();

    expect(skipped).toBe(0);
    expect(records[0]?.title).toBe('A'.repeat(500));
  });

  it('skips a record with an over-long imdbId rather than truncating a join key (SEC-05)', async () => {
    mockFetch.mockResolvedValue(jsonResponse([{ ...validMovie, imdbId: 'tt' + '1'.repeat(30) }]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getMovieRequests();

    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('skips a record with an over-long requester id rather than truncating a join key (SEC-05)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        {
          ...validMovie,
          requestedUser: { ...validMovie.requestedUser, id: 'x'.repeat(100) },
        },
      ])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getMovieRequests();

    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('sends redirect: manual so a 30x from Ombi is never followed (SEC-02)', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));

    const service = new OmbiService('http://localhost:5420', 'key');
    await service.getMovieRequests();

    const [, init] = mockFetch.mock.calls[0] as [string, { redirect: string }];
    expect(init.redirect).toBe('manual');
  });

  it('rejects an opaque redirect response without retrying (SEC-02)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 0,
      statusText: '',
      type: 'opaqueredirect',
      headers: { get: () => null },
      json: async () => {
        throw new Error('should not be reached - the redirect must be rejected first');
      },
    });

    const service = new OmbiService('http://localhost:5420', 'key');
    await expect(service.getMovieRequests()).rejects.toBeInstanceOf(OmbiInvalidResponseError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry on a redirect
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
      json: async () => [],
    });

    const service = new OmbiService('http://localhost:5420', 'key');
    await expect(service.getMovieRequests()).rejects.toBeInstanceOf(OmbiInvalidResponseError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('derives status precedence: available > denied > approved > pending', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { ...validMovie, id: 1, available: false, denied: true, approved: true },
        { ...validMovie, id: 2, available: false, denied: false, approved: true },
        { ...validMovie, id: 3, available: false, denied: false, approved: false },
      ])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records } = await service.getMovieRequests();

    expect(records.map((r) => r.status)).toEqual(['denied', 'approved', 'pending']);
  });

  it('skips a malformed record and keeps processing valid ones (never fails the whole run)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([validMovie, { id: 999 /* missing required fields */ }])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getMovieRequests();

    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('throws OmbiInvalidResponseError when the top-level payload is not an array (HTML fallback)', async () => {
    mockFetch.mockResolvedValue(htmlResponse());

    const service = new OmbiService('http://localhost:5420', 'key');
    await expect(service.getMovieRequests()).rejects.toBeInstanceOf(OmbiInvalidResponseError);
  });

  it('throws OmbiAuthError on a 403 without retrying', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 403));

    const service = new OmbiService('http://localhost:5420', 'key');
    await expect(service.getMovieRequests()).rejects.toBeInstanceOf(OmbiAuthError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it(`retries up to ${OMBI_MAX_RETRIES} times on a transient failure, then succeeds`, async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(jsonResponse([validMovie]));

      const service = new OmbiService('http://localhost:5420', 'key');
      const promise = service.getMovieRequests();
      await vi.advanceTimersByTimeAsync(1500);
      const result = await promise;

      expect(result.records).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OmbiService.getTvRequests', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  const parent = {
    id: 500,
    tvDbId: 12345,
    imdbId: 'tt7654321',
    title: 'Some Show',
    childRequests: [
      {
        id: 501,
        parentRequestId: 500,
        requestedDate: '2025-01-01T00:00:00.0000000Z',
        requestedUser: {
          id: 'ombi-guid-2',
          userName: 'bob',
          alias: 'Bobby',
          providerUserId: null,
        },
        approved: true,
        denied: false,
        available: false,
        markedAsAvailable: null,
        seasonRequests: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
        releaseYear: 2018,
      },
    ],
  };

  it('flattens childRequests into one record per child, denormalizing parent fields', async () => {
    mockFetch.mockResolvedValue(jsonResponse([parent]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ombiRequestId: 501,
      ombiParentRequestId: 500,
      mediaType: 'tv',
      title: 'Some Show', // from the PARENT
      imdbId: 'tt7654321', // from the PARENT
      tvdbId: 12345, // from the PARENT
      releaseYear: 2018, // from the CHILD
      seasons: [1, 2],
      is4k: false,
      status: 'approved',
      requester: {
        ombiUserId: 'ombi-guid-2',
        ombiUsername: 'bob',
        ombiAlias: 'Bobby',
        providerUserId: null,
      },
    });
  });

  // Regression: the first live sync against a real Ombi 4.47.1 mirrored 0 of 274
  // TV requests. Ombi sends `denied: null` (not absent) on 279/280 children, and a
  // Zod `.default(false)` only applies to `undefined` - so every child failed
  // validation and was skipped. Fixture mirrors the real payload exactly.
  it('accepts explicit nulls for booleans Ombi leaves unset (denied)', async () => {
    const childWithNullDenied = { ...parent.childRequests[0], denied: null, approved: true };
    mockFetch.mockResolvedValue(
      jsonResponse([{ ...parent, childRequests: [childWithNullDenied] }])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'approved', ombiRequestId: 501 });
  });

  it('skips a malformed child but keeps its siblings under the same parent', async () => {
    const badChild = { id: 502 /* missing requestedUser etc */ };
    mockFetch.mockResolvedValue(
      jsonResponse([{ ...parent, childRequests: [parent.childRequests[0], badChild] }])
    );

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('skips an entire malformed parent, counting all of its children as skipped', async () => {
    const badParent = { id: 999, childRequests: [{ id: 1 }, { id: 2 }] }; // missing title
    mockFetch.mockResolvedValue(jsonResponse([parent, badParent]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(records).toHaveLength(1); // only the good parent's child
    expect(skipped).toBe(2); // both of the bad parent's children
  });

  it('throws OmbiInvalidResponseError when the top-level payload is not an array', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ not: 'an array' }));

    const service = new OmbiService('http://localhost:5420', 'key');
    await expect(service.getTvRequests()).rejects.toBeInstanceOf(OmbiInvalidResponseError);
  });

  it('skips an entire parent with an over-long imdbId rather than truncating a join key (SEC-05)', async () => {
    const badParent = { ...parent, id: 998, imdbId: 'tt' + '9'.repeat(30) };
    mockFetch.mockResolvedValue(jsonResponse([badParent]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(records).toHaveLength(0);
    expect(skipped).toBe(1); // the parent's one child
  });

  it('truncates an over-long parent title to the column width instead of skipping (SEC-05)', async () => {
    const longTitleParent = { ...parent, id: 997, title: 'B'.repeat(600) };
    mockFetch.mockResolvedValue(jsonResponse([longTitleParent]));

    const service = new OmbiService('http://localhost:5420', 'key');
    const { records, skipped } = await service.getTvRequests();

    expect(skipped).toBe(0);
    expect(records[0]?.title).toBe('B'.repeat(500));
  });
});
