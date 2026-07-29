/**
 * CR-4 boundary test: wires the REAL `asJsonFetcher` (utils/safeProbe.ts) -
 * the hardened fetcher `/emby/setup` actually passes to `EmbyClient` in
 * production (embySetupPlugin.ts's `buildRealPorts`) - into
 * `EmbyClient.verifyServerAdmin`/`authenticate`, against a stubbed 401/403
 * HTTP response. Neither side's own unit-mock suite (client.test.ts mocks
 * `fetchJson` directly; safeProbe.test.ts never calls into EmbyClient) proves
 * the seam actually works: client.test.ts's mocks hand-construct a real
 * `HttpClientError`, which is exactly what was broken before the CR-4 fix -
 * `safeProbeJson` used to throw a DIFFERENT class (`ProbeFailedError`, no
 * status at all) for every non-ok response, so `EmbyClient`'s
 * `instanceof HttpClientError && statusCode === 401/403` checks silently
 * never matched when this real fetcher was used, collapsing every case to
 * `CONNECTION_FAILED` (verifyServerAdmin) or an uncaught 500 (authenticate).
 * No live Postgres/Docker or real Emby server is needed - only the DNS
 * `lookup` and the low-level `fetchImpl` are stubbed; every layer in between
 * (safeProbeJson's address validation, HttpClientError construction, undici
 * Agent bypass note, and EmbyClient's own discrimination logic) is real.
 */

import { describe, it, expect, vi } from 'vitest';
import { asJsonFetcher } from '../../../../utils/safeProbe.js';
import { EmbyClient } from '../client.js';

const URL = 'http://192.168.1.10:8096';

function fakeLookup() {
  return vi.fn().mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
}

/** Routes a fake low-level fetch by which path suffix the request URL ends with. */
function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [suffix, factory] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return factory();
    }
    throw new Error(`test fetchImpl: unexpected request to ${url}`);
  }) as unknown as typeof fetch;
}

function jsonOk(body: unknown = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function status(code: number) {
  return () => new Response('', { status: code, statusText: 'stubbed' });
}

describe('EmbyClient against the real asJsonFetcher/safeProbeJson seam (CR-4)', () => {
  it('verifyServerAdmin: a 401 on BOTH /Users/Me and /Auth/Keys maps to INVALID_KEY, not CONNECTION_FAILED', async () => {
    const fetchImpl = routedFetch({
      '/System/Info/Public': jsonOk(),
      '/Users/Me': status(401),
      '/Auth/Keys': status(401),
    });
    const fetcher = asJsonFetcher({ timeoutMs: 1000, deps: { lookup: fakeLookup(), fetchImpl } });

    const result = await EmbyClient.verifyServerAdmin('bad-key', URL, fetcher);

    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('verifyServerAdmin: a 403 on /Auth/Keys (after a non-401 /Users/Me) maps to NOT_ADMIN, not CONNECTION_FAILED', async () => {
    const fetchImpl = routedFetch({
      '/System/Info/Public': jsonOk(),
      '/Users/Me': status(400),
      '/Auth/Keys': status(403),
    });
    const fetcher = asJsonFetcher({ timeoutMs: 1000, deps: { lookup: fakeLookup(), fetchImpl } });

    const result = await EmbyClient.verifyServerAdmin('key', URL, fetcher);

    expect(result).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('verifyServerAdmin: succeeds via /Users/Me for an admin user token, through the real hardened fetcher', async () => {
    const fetchImpl = routedFetch({
      '/System/Info/Public': jsonOk(),
      '/Users/Me': jsonOk({ Id: 'u1', Name: 'owner', Policy: { IsAdministrator: true } }),
    });
    const fetcher = asJsonFetcher({ timeoutMs: 1000, deps: { lookup: fakeLookup(), fetchImpl } });

    const result = await EmbyClient.verifyServerAdmin('key', URL, fetcher);

    expect(result).toEqual({ success: true });
  });

  it('authenticate: a 401 on /Users/AuthenticateByName returns null (bad credentials), never a thrown 500', async () => {
    const fetchImpl = routedFetch({ '/Users/AuthenticateByName': status(401) });
    const fetcher = asJsonFetcher({ timeoutMs: 1000, deps: { lookup: fakeLookup(), fetchImpl } });

    // The regression this guards: pre-fix, safeProbeJson's ProbeFailedError
    // carried no status and a message that never contains "401", so
    // authenticate's old `error.message.includes('401')` check missed and
    // the error escaped uncaught - exactly what turns a mistyped Emby
    // password into a 500 SETUP_FAILED at the /emby/setup HTTP boundary.
    const result = await EmbyClient.authenticate(URL, 'owner', 'wrong-password', fetcher);

    expect(result).toBeNull();
  });

  it('authenticate: succeeds through the real hardened fetcher for correct credentials', async () => {
    const fetchImpl = routedFetch({
      '/Users/AuthenticateByName': jsonOk({
        AccessToken: 'tok',
        User: { Id: 'u1', Name: 'owner', Policy: { IsAdministrator: true } },
      }),
    });
    const fetcher = asJsonFetcher({ timeoutMs: 1000, deps: { lookup: fakeLookup(), fetchImpl } });

    const result = await EmbyClient.authenticate(URL, 'owner', 'correct-password', fetcher);

    expect(result).toMatchObject({ id: 'u1', isAdmin: true });
  });
});
