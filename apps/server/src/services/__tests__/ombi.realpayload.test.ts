/**
 * Validates the schemas against the FULL real Ombi 4.47.1 payload captured from
 * a live instance (658 movie requests, 274 TV parents / 280 children).
 *
 * Two schema mismatches shipped past the hand-written fixtures and were only
 * caught by a live sync: `denied: null` (dropped 100% of TV) and `releaseYear`
 * arriving as a date string. Fixtures encode what we imagined; this encodes what
 * the server actually sends. Skips itself when the capture isn't present, so it
 * never breaks CI or another contributor's checkout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmbiService } from '../ombi.js';

const FIXTURE_DIR = process.env.OMBI_CAPTURE_DIR ?? '';
const moviePath = FIXTURE_DIR ? join(FIXTURE_DIR, 'ombi_movie.json') : '';
const tvPath = FIXTURE_DIR ? join(FIXTURE_DIR, 'ombi_tv.json') : '';
const hasCapture = Boolean(FIXTURE_DIR) && existsSync(moviePath) && existsSync(tvPath);

describe.skipIf(!hasCapture)('OmbiService against the real captured payload', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  const respond = (body: unknown) =>
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
    });

  it('parses every real movie request without skipping any', async () => {
    const raw: unknown[] = JSON.parse(readFileSync(moviePath, 'utf-8'));
    respond(raw);
    const { records, skipped } = await new OmbiService(
      'http://localhost:5420',
      'k'
    ).getMovieRequests();
    expect(skipped).toBe(0);
    expect(records).toHaveLength(raw.length);
  });

  it('parses every real TV child request without skipping any', async () => {
    const raw: Array<{ childRequests?: unknown[] }> = JSON.parse(readFileSync(tvPath, 'utf-8'));
    const childCount = raw.reduce((n, p) => n + (p.childRequests?.length ?? 0), 0);
    respond(raw);
    const { records, skipped } = await new OmbiService(
      'http://localhost:5420',
      'k'
    ).getTvRequests();
    expect(skipped).toBe(0);
    expect(records).toHaveLength(childCount);
  });
});
