import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, AUTH_STATE_CHANGE_EVENT } from './api';

function mockFetch401() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('api client 401 handling', () => {
  let authEvents: number;
  const onAuthChange = () => {
    authEvents += 1;
  };

  beforeEach(() => {
    authEvents = 0;
    window.addEventListener(AUTH_STATE_CHANGE_EVENT, onAuthChange);
  });

  afterEach(() => {
    window.removeEventListener(AUTH_STATE_CHANGE_EVENT, onAuthChange);
    vi.restoreAllMocks();
  });

  it('does not fire the auth-state event when /auth/me 401s (expected while logged out)', async () => {
    mockFetch401();

    await expect(api.auth.me()).rejects.toThrow();
    expect(authEvents).toBe(0);
  });

  it('fires the auth-state event when a data endpoint 401s (lost session)', async () => {
    mockFetch401();

    await expect(api.channelRouting.getAll()).rejects.toThrow();
    expect(authEvents).toBe(1);
  });
});

describe('api.violations.list query params', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends serverUserId, not userId, so a single account is scoped by the server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [], page: 1, pageSize: 10, total: 0, totalPages: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const accountId = 'abc-123';
    await api.violations.list({ serverUserId: accountId, page: 2, pageSize: 10 });

    const requestedUrl = new URL(fetchSpy.mock.calls[0]?.[0] as string, 'http://localhost');
    expect(requestedUrl.searchParams.get('serverUserId')).toBe(accountId);
    expect(requestedUrl.searchParams.has('userId')).toBe(false);
  });
});
