import { describe, it, expect, vi } from 'vitest';
import { safeProbeJson, ProbeBlockedError, ProbeFailedError } from '../safeProbe.js';

function fakeLookup(addresses: { address: string; family: number }[]) {
  return vi.fn().mockResolvedValue(addresses);
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('safeProbeJson', () => {
  it('rejects a denied literal before any DNS lookup or fetch', async () => {
    const lookup = fakeLookup([{ address: '10.0.0.1', family: 4 }]);
    const fetchImpl = vi.fn();

    await expect(
      safeProbeJson(
        'http://169.254.169.254/',
        { service: 'emby', timeoutMs: 1000 },
        { lookup, fetchImpl }
      )
    ).rejects.toBeInstanceOf(ProbeBlockedError);

    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when the hostname resolves to a denied address (DNS rebinding)', async () => {
    const lookup = fakeLookup([{ address: '169.254.169.254', family: 4 }]);
    const fetchImpl = vi.fn();

    await expect(
      safeProbeJson(
        'http://emby.example.com/',
        { service: 'emby', timeoutMs: 1000 },
        { lookup, fetchImpl }
      )
    ).rejects.toBeInstanceOf(ProbeBlockedError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when a hostname resolves to BOTH a public and a denied address - no "use the good one" fallback', async () => {
    const lookup = fakeLookup([
      { address: '192.168.1.10', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const fetchImpl = vi.fn();

    await expect(
      safeProbeJson(
        'http://emby.example.com/',
        { service: 'emby', timeoutMs: 1000 },
        { lookup, fetchImpl }
      )
    ).rejects.toBeInstanceOf(ProbeBlockedError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolution returns no addresses', async () => {
    const lookup = fakeLookup([]);
    const fetchImpl = vi.fn();

    await expect(
      safeProbeJson(
        'http://emby.example.com/',
        { service: 'emby', timeoutMs: 1000 },
        { lookup, fetchImpl }
      )
    ).rejects.toBeInstanceOf(ProbeBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a 3xx redirect (opaqueredirect via redirect:"manual") as REDIRECTED, never following it', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);
    // fetch's `redirect: 'manual'` yields a response with type
    // 'opaqueredirect' and no readable status/Location - emulate that here,
    // matching the exact mechanism this module and services/ombi.ts rely on.
    const fetchImpl = vi.fn().mockResolvedValue({ type: 'opaqueredirect' });

    const error = await safeProbeJson(
      'http://192.168.1.10:8096/System/Info/Public',
      { service: 'emby', timeoutMs: 1000 },
      { lookup, fetchImpl }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProbeFailedError);
    expect((error as ProbeFailedError).code).toBe('REDIRECTED');
  });

  it('treats a 307 redirect the same as a 302 - body is never re-sent because the redirect is never followed', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);
    const fetchImpl = vi.fn().mockResolvedValue({ type: 'opaqueredirect' });

    const error = await safeProbeJson(
      'http://192.168.1.10:8096/Users/AuthenticateByName',
      { service: 'emby', timeoutMs: 1000, method: 'POST', body: JSON.stringify({ Pw: 'secret' }) },
      { lookup, fetchImpl }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProbeFailedError);
    expect((error as ProbeFailedError).code).toBe('REDIRECTED');
    // fetchImpl is only ever invoked once - undici/fetch never re-issues the
    // request to the redirect target, so the body cannot leak there.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never surfaces upstream status/status text/body in the thrown message, but forwards it to onUpstreamError', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('super secret internal stack trace', {
        status: 500,
        statusText: 'Internal Server Error',
      })
    );
    const onUpstreamError = vi.fn();

    const error = await safeProbeJson(
      'http://192.168.1.10:8096/',
      { service: 'emby', timeoutMs: 1000, onUpstreamError },
      { lookup, fetchImpl }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProbeFailedError);
    expect((error as Error).message).not.toMatch(/500|Internal Server Error|stack trace/);
    expect(onUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, statusText: 'Internal Server Error' })
    );
  });

  it('resolves with the parsed JSON body on success', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ Id: 'abc', IsAdministrator: true }));

    const result = await safeProbeJson<{ Id: string }>(
      'http://192.168.1.10:8096/Users/Me',
      { service: 'emby', timeoutMs: 1000 },
      { lookup, fetchImpl }
    );

    expect(result).toEqual({ Id: 'abc', IsAdministrator: true });
  });

  it('rejects a network failure as UNREACHABLE without leaking the underlying error text', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 192.168.1.10:8096'));

    const error = await safeProbeJson(
      'http://192.168.1.10:8096/',
      { service: 'emby', timeoutMs: 1000 },
      { lookup, fetchImpl }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProbeFailedError);
    expect((error as ProbeFailedError).code).toBe('UNREACHABLE');
    expect((error as Error).message).not.toMatch(/ECONNREFUSED/);
  });
});
