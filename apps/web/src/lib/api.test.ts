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

    await expect(api.destinations.list()).rejects.toThrow();
    expect(authEvents).toBe(1);
  });
});

describe('api.destinations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockJson(body: unknown, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  }

  function callArgs(fetchSpy: ReturnType<typeof mockJson>) {
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    return { url: String(url), init };
  }

  it('lists from /destinations', async () => {
    const fetchSpy = mockJson([]);

    await api.destinations.list();

    expect(callArgs(fetchSpy).url).toContain('/destinations');
  });

  it('creates with a POST carrying the input body', async () => {
    const fetchSpy = mockJson({ id: 'd1' });
    const input = {
      name: 'Discord',
      type: 'discord' as const,
      config: { webhookUrl: 'https://discord.com/api/webhooks/x' },
      events: ['violation_detected' as const],
      enabled: true,
    };

    await api.destinations.create(input);

    const { url, init } = callArgs(fetchSpy);
    expect(url).toMatch(/\/destinations$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('updates with a PATCH to the destination id', async () => {
    const fetchSpy = mockJson({ id: 'd1' });

    await api.destinations.update('d1', { enabled: false });

    const { url, init } = callArgs(fetchSpy);
    expect(url).toMatch(/\/destinations\/d1$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
  });

  it('removes with a DELETE and tolerates the 204', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.destinations.remove('d1')).resolves.toBeUndefined();

    const { url, init } = callArgs(fetchSpy);
    expect(url).toMatch(/\/destinations\/d1$/);
    expect(init?.method).toBe('DELETE');
  });

  it('carries the 409 body so a blocked delete can name the rules', async () => {
    mockJson({ message: 'Used by 1 rule(s)', rules: ['No 4K transcodes'] }, 409);

    await expect(api.destinations.remove('d1')).rejects.toMatchObject({
      status: 409,
      body: { rules: ['No 4K transcodes'] },
    });
  });

  it('tests a saved destination by id and an unsaved one by config', async () => {
    const savedSpy = mockJson({ success: true });
    await api.destinations.test('d1');
    expect(callArgs(savedSpy).url).toMatch(/\/destinations\/d1\/test$/);
    vi.restoreAllMocks();

    const unsavedSpy = mockJson({ success: true });
    await api.destinations.testUnsaved({ type: 'ntfy', config: { url: 'https://ntfy.sh/' } });
    const { url, init } = callArgs(unsavedSpy);
    expect(url).toMatch(/\/destinations\/test$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'ntfy',
      config: { url: 'https://ntfy.sh/' },
    });
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
