import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeProbeJson, ProbeBlockedError, ProbeFailedError } from '../safeProbe.js';
import { HttpClientError } from '../http.js';

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

  it('never surfaces upstream status/status text/body in the thrown MESSAGE, but forwards it to onUpstreamError', async () => {
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

    expect(error).toBeInstanceOf(HttpClientError);
    expect((error as Error).message).not.toMatch(/500|Internal Server Error|stack trace/);
    expect(onUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, statusText: 'Internal Server Error' })
    );
  });

  it('CR-4: a non-ok response throws HttpClientError carrying the REAL status code as data (never in the message)', async () => {
    const lookup = fakeLookup([{ address: '192.168.1.10', family: 4 }]);

    for (const status of [401, 403]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('unauthorized', { status, statusText: 'nope' }));

      const error = await safeProbeJson(
        'http://192.168.1.10:8096/Users/Me',
        { service: 'emby', timeoutMs: 1000 },
        { lookup, fetchImpl }
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpClientError);
      expect((error as HttpClientError).statusCode).toBe(status);
      // The status is DATA on the error object, not upstream prose in the
      // message - the fixed message never contains the status/statusText.
      expect((error as Error).message).not.toMatch(/401|403|nope/);
    }
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

// ============================================================================
// IMP-02: connect-pinning is the PRIMARY SSRF control and, before this suite,
// had ZERO test coverage - every case above injects `fetchImpl`, which
// bypasses the real pinning mechanism entirely (the actual code path a real
// /emby/setup or /plex/connect request takes). These tests deliberately do
// NOT inject `fetchImpl`, so they exercise the real mechanism end to end.
//
// Two things were confirmed empirically while fixing this (both against this
// repo's actual installed Node/undici versions, not assumed):
//
// 1. The design's ORIGINALLY-intended mechanism - an undici `Agent` whose
//    `connect.lookup` pins the validated address, handed to the global
//    `fetch` as its `dispatcher` - is CONFIRMED BROKEN: Node's global
//    `fetch` validates a passed `dispatcher` against the shape of its OWN
//    internally bundled `undici`, and a directly-installed `undici` package
//    instance (this repo's `^8.2.0` dep) never satisfies that check -
//    every call throws `InvalidArgumentError: invalid onRequestStart method`
//    (`UND_ERR_INVALID_ARG`). safeProbe.ts's fix abandons that mechanism
//    entirely for the documented spec §8.2 fallback: request the validated
//    literal address directly, with the original hostname carried via an
//    explicit `Host` header.
// 2. Even setting the Agent question aside, the `connect.lookup` callback
//    contract itself was wrong: Node ≥18.13/20 defaults `autoSelectFamily`
//    to true (confirmed via `net.getDefaultAutoSelectFamily()` on this
//    repo's Node), and a bare `net.connect({ lookup })` under that default
//    invokes `lookup(host, { hints, all: true }, cb)` expecting
//    `cb(err, addresses[])` - an ARRAY - not the singular
//    `cb(err, address, family)` form the pre-fix code always used. Moot for
//    the CURRENT code (no Agent/`connect.lookup` is built at all any more),
//    but recorded here because it would resurface immediately if the Agent
//    mechanism is ever reintroduced (e.g. if a future undici/Node release
//    fixes the dispatcher hand-off) without ALSO fixing this.
// ============================================================================
describe('safeProbeJson: real connect-pinning end to end (no fetchImpl injected, IMP-02)', () => {
  async function withLocalServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const { port } = server.address() as AddressInfo;
    return {
      server,
      port,
      close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
    };
  }

  it('pins the connection to the injected lookup address and succeeds end to end, against a hostname real DNS could never resolve', async () => {
    let receivedHost: string | undefined;
    const { port, close } = await withLocalServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      // A syntactically valid but unresolvable hostname (the `.invalid` TLD
      // is reserved by RFC 2606 to never resolve) - if the literal-address
      // pin did NOT take effect, the real fetch would attempt real DNS
      // resolution of this hostname and fail, never reaching the local
      // server below.
      const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      const result = await safeProbeJson<{ ok: boolean }>(
        `http://this-host-can-never-resolve.invalid:${port}/`,
        { service: 'test', timeoutMs: 3000 },
        { lookup } // deliberately no fetchImpl - real fetch, real network connection
      );

      expect(result).toEqual({ ok: true });
      expect(lookup).toHaveBeenCalledWith('this-host-can-never-resolve.invalid');
      // The connection went to the literal IP (proven by getting a response
      // at all, from a hostname real DNS could never resolve), but the
      // ORIGINAL hostname must still arrive as the Host header so the
      // target server's own virtual-hosting/routing still works.
      expect(receivedHost).toBe(`this-host-can-never-resolve.invalid:${port}`);
    } finally {
      await close();
    }
  });

  it('rejects a denied address BEFORE any real connection attempt, with no fetchImpl injected', async () => {
    // No local server needed at all: if the deny-list check (step 2,
    // resolveAndValidate) is bypassed for the real-fetch path, this would
    // hang/timeout or attempt a real connection to the metadata address
    // instead of rejecting immediately.
    const lookup = vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const error = await safeProbeJson(
      'http://denied-address-test.invalid:1/',
      { service: 'test', timeoutMs: 1000 },
      { lookup }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProbeBlockedError);
  });

  it('sends a POST body correctly through the real pinned request path', async () => {
    let receivedBody = '';
    let receivedMethod = '';
    const { port, close } = await withLocalServer((req, res) => {
      receivedMethod = req.method ?? '';
      req.on('data', (chunk: Buffer) => {
        receivedBody += chunk.toString('utf8');
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    try {
      const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      const result = await safeProbeJson<{ ok: boolean }>(
        `http://post-body-test.invalid:${port}/Users/AuthenticateByName`,
        {
          service: 'test',
          timeoutMs: 3000,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ Username: 'owner', Pw: 'secret' }),
        },
        { lookup }
      );

      expect(result).toEqual({ ok: true });
      expect(receivedMethod).toBe('POST');
      expect(JSON.parse(receivedBody)).toEqual({ Username: 'owner', Pw: 'secret' });
    } finally {
      await close();
    }
  });

  it('treats a real 3xx response as REDIRECTED through the real pinned request path, never following it', async () => {
    let getCallCount = 0;
    const { port, close } = await withLocalServer((_req, res) => {
      getCallCount += 1;
      res.writeHead(302, { location: 'http://169.254.169.254/should-never-be-followed' });
      res.end();
    });

    try {
      const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      const error = await safeProbeJson(
        `http://redirect-test.invalid:${port}/`,
        { service: 'test', timeoutMs: 3000 },
        { lookup }
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProbeFailedError);
      expect((error as ProbeFailedError).code).toBe('REDIRECTED');
      // The redirect target is never fetched - only the ONE request to the
      // local server itself happened.
      expect(getCallCount).toBe(1);
    } finally {
      await close();
    }
  });
});
