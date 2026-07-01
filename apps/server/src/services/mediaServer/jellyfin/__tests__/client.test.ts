import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { JellyfinClient } from '../client.js';

const mockFetchJson = vi.mocked(fetchJson);

const URL = 'http://jellyfin.local:8096';

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'jellyfin',
    statusCode,
    statusText: 'error',
    url: `${URL}/x`,
  });
}

/** Ordered resolver for the sequence of fetchJson calls a verify makes. */
function sequence(...steps: Array<{ resolve?: unknown; reject?: Error }>) {
  let call = 0;
  mockFetchJson.mockImplementation(async () => {
    const step = steps[call++];
    if (!step) throw new Error('unexpected fetchJson call');
    if (step.reject) throw step.reject;
    return step.resolve;
  });
}

describe('JellyfinClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('uses the standard Authorization header', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    await JellyfinClient.verifyServerAdmin('key', URL);

    const usersMeCall = mockFetchJson.mock.calls[1];
    const headers = (usersMeCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toContain('MediaBrowser');
    expect(headers).not.toHaveProperty('X-Emby-Authorization');
  });

  it('succeeds for an admin user token via /Users/Me', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    const result = await JellyfinClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({ success: true });
  });

  it('returns NOT_ADMIN for a non-admin user token', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: false } } }
    );

    const result = await JellyfinClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({
      success: false,
      code: JellyfinClient.AdminVerifyError.NOT_ADMIN,
      message: expect.any(String),
    });
  });

  it('succeeds for an admin API key via /Auth/Keys (after /Users/Me 400)', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { resolve: {} });

    const result = await JellyfinClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({ success: true });
  });

  it('returns INVALID_KEY when /Users/Me responds 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(401) });

    const result = await JellyfinClient.verifyServerAdmin('bad', URL);
    expect(result).toMatchObject({
      success: false,
      code: JellyfinClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns INVALID_KEY when /Auth/Keys responds 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: httpError(401) });

    const result = await JellyfinClient.verifyServerAdmin('bad', URL);
    expect(result).toMatchObject({
      success: false,
      code: JellyfinClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns NOT_ADMIN when /Auth/Keys responds 403', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: httpError(403) });

    const result = await JellyfinClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: JellyfinClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('returns CONNECTION_FAILED when the server is unreachable', async () => {
    sequence({ reject: new Error('ECONNREFUSED') });

    const result = await JellyfinClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
    });
  });
});
