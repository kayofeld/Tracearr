import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { EmbyClient } from '../client.js';

const mockFetchJson = vi.mocked(fetchJson);

const URL = 'http://emby.local:8096';

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'emby',
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

describe('EmbyClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('uses the X-Emby-Authorization header', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    await EmbyClient.verifyServerAdmin('key', URL);

    const usersMeCall = mockFetchJson.mock.calls[1];
    const headers = (usersMeCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Emby-Authorization']).toContain('MediaBrowser');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('succeeds for an admin user token via /Users/Me', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({ success: true });
  });

  it('returns NOT_ADMIN for a non-admin user token', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: false } } }
    );

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
      message: expect.any(String),
    });
  });

  it('succeeds for an admin API key via /Auth/Keys (after /Users/Me 400)', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { resolve: {} });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({ success: true });
  });

  it('succeeds for an admin API key when /Users/Me returns 500 (observed Emby 4.9.5 behavior)', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { resolve: {} });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toEqual({ success: true });
  });

  it('fails closed (NOT_ADMIN) when /Users/Me returns a malformed 200 body', async () => {
    sequence({ resolve: {} }, { resolve: { unexpected: 'shape' } });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    // parseUser defaults isAdmin to false when Policy is missing, so a malformed
    // 200 body must read as NOT_ADMIN — never as success.
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('returns CONNECTION_FAILED when /Auth/Keys gets a proxy-style 502', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: httpError(502) });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
    });
  });

  it('returns INVALID_KEY when /Users/Me responds 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(401) });

    const result = await EmbyClient.verifyServerAdmin('bad', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns INVALID_KEY when /Auth/Keys responds 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: httpError(401) });

    const result = await EmbyClient.verifyServerAdmin('bad', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns NOT_ADMIN when /Auth/Keys responds 403', async () => {
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: httpError(403) });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('returns CONNECTION_FAILED when the server is unreachable', async () => {
    sequence({ reject: new Error('ECONNREFUSED') });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
    });
  });

  it('treats a transient network error on /Auth/Keys as CONNECTION_FAILED, not a rejection', async () => {
    // Regression: the old boolean implementation swallowed this as `false`,
    // wrongly reporting a legitimate admin key as non-admin on a network blip.
    sequence({ resolve: {} }, { reject: httpError(400) }, { reject: new Error('ETIMEDOUT') });

    const result = await EmbyClient.verifyServerAdmin('key', URL);
    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
    });
  });
});
