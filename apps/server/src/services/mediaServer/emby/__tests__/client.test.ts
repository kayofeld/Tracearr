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

describe('EmbyClient.authenticate', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('sends the plaintext password in the `Pw` field, not `Password`', async () => {
    // Regression: Emby 4.9.5 returns 401 when the password is sent as `Password`;
    // it must be `Pw` (verified live). Getting this wrong breaks Emby login entirely.
    mockFetchJson.mockResolvedValue({
      AccessToken: 'tok',
      User: { Id: 'u1', Name: 'demo', Policy: { IsAdministrator: true } },
    });

    const result = await EmbyClient.authenticate(URL, 'demo', 's3cret!!');

    const call = mockFetchJson.mock.calls[0];
    expect(call?.[0]).toBe(`${URL}/Users/AuthenticateByName`);
    const body = JSON.parse((call?.[1]?.body as string) ?? '{}') as Record<string, unknown>;
    expect(body.Pw).toBe('s3cret!!');
    expect(body.Username).toBe('demo');
    expect(body).not.toHaveProperty('Password');
    expect(result?.isAdmin).toBe(true);
  });

  it('returns null on a 401 (bad credentials)', async () => {
    mockFetchJson.mockRejectedValue(new Error('emby request failed: 401 Unauthorized'));
    const result = await EmbyClient.authenticate(URL, 'demo', 'wrong');
    expect(result).toBeNull();
  });
});

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

describe('EmbyClient.diagnoseLoginFailure', () => {
  const ADMIN_KEY = 'admin-key';
  const TIMEOUT_MS = 3000;

  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('uses the admin key (X-Emby-Authorization) and the given timeout, never the submitted password', async () => {
    mockFetchJson.mockResolvedValue([{ Name: 'demo', Policy: { IsDisabled: false } }]);

    await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    const call = mockFetchJson.mock.calls[0];
    expect(call?.[0]).toBe(`${URL}/Users`);
    const options = call?.[1] as { headers?: Record<string, string>; timeout?: number };
    expect(options?.headers?.['X-Emby-Authorization']).toContain(ADMIN_KEY);
    expect(options?.timeout).toBe(TIMEOUT_MS);
  });

  it('matches the username case-insensitively', async () => {
    mockFetchJson.mockResolvedValue([{ Name: 'Demo', Policy: {} }]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'DEMO', TIMEOUT_MS);

    expect(result).toBe('wrong_password');
  });

  it('returns user_not_found when no user with that name exists', async () => {
    mockFetchJson.mockResolvedValue([{ Name: 'someone-else', Policy: {} }]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('user_not_found');
  });

  it('returns account_disabled when Policy.IsDisabled is true', async () => {
    mockFetchJson.mockResolvedValue([{ Name: 'demo', Policy: { IsDisabled: true } }]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('account_disabled');
  });

  it('returns account_locked_out when invalid attempts meet a positive lockout threshold', async () => {
    mockFetchJson.mockResolvedValue([
      {
        Name: 'demo',
        Policy: { IsDisabled: false, LoginAttemptsBeforeLockout: 3, InvalidLoginAttemptCount: 3 },
      },
    ]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('account_locked_out');
  });

  it('does NOT claim a lockout when LoginAttemptsBeforeLockout is missing (not reliably observable)', async () => {
    // Some Emby versions/configs never populate this field. Absent a
    // verifiable threshold, this must fall back to wrong_password rather
    // than fabricate a lockout state.
    mockFetchJson.mockResolvedValue([
      { Name: 'demo', Policy: { IsDisabled: false, InvalidLoginAttemptCount: 10 } },
    ]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('wrong_password');
  });

  it('does NOT claim a lockout when LoginAttemptsBeforeLockout is 0/disabled', async () => {
    mockFetchJson.mockResolvedValue([
      {
        Name: 'demo',
        Policy: { IsDisabled: false, LoginAttemptsBeforeLockout: 0, InvalidLoginAttemptCount: 50 },
      },
    ]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('wrong_password');
  });

  it('returns wrong_password when the account exists, is not disabled, and is not locked out', async () => {
    mockFetchJson.mockResolvedValue([{ Name: 'demo', Policy: { IsDisabled: false } }]);

    const result = await EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS);

    expect(result).toBe('wrong_password');
  });

  it('throws when the admin key is rejected (caller must fall back)', async () => {
    mockFetchJson.mockRejectedValue(httpError(401));

    await expect(
      EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS)
    ).rejects.toThrow();
  });

  it('throws when the /Users response is not an array (cannot determine)', async () => {
    mockFetchJson.mockResolvedValue({ unexpected: 'shape' });

    await expect(
      EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS)
    ).rejects.toThrow();
  });

  it('throws on a network error/timeout (caller must fall back)', async () => {
    mockFetchJson.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      EmbyClient.diagnoseLoginFailure(URL, ADMIN_KEY, 'demo', TIMEOUT_MS)
    ).rejects.toThrow();
  });
});
