/**
 * Hardened outbound probe for pre-auth, client-supplied-URL paths (the
 * `/emby/setup` SEC-03 fix, docs/architecture/emby-native-setup.md §8).
 *
 * `assertSafeProbeUrl` (ssrf.ts) is a literal-only, defense-in-depth check:
 * it never resolves hostnames, so a hostname that resolves to a denied
 * address (DNS rebinding) sails through it, and it never guards against a
 * redirect chain that lands on a denied address after the literal check has
 * already passed. This module is the primary control for a path that must
 * survive a deliberate attacker:
 *
 *   1. Pre-flight the literal URL with `assertSafeProbeUrl`.
 *   2. Resolve the hostname and validate EVERY returned address against the
 *      same deny list (§8.3) - an empty result or any denied address fails
 *      the whole request; there is no "use the good one" fallback, because a
 *      name that resolves to both a legitimate and a denied address is
 *      exactly the rebinding shape being defended against.
 *   3. Pin the connection to the already-validated address (spec §8.2's
 *      documented FALLBACK mechanism, not the originally-intended one - see
 *      below): the request is made directly against the validated literal
 *      IP via Node's raw `http`/`https` modules (NOT the standard `fetch()`
 *      API - see why below), carrying the original hostname as an explicit
 *      `Host` header and, for https, an explicit TLS `servername` (SNI), so
 *      name-based virtual hosting and certificate validation on the target
 *      server both still work correctly. There is no TOCTOU gap between the
 *      check and the connect - there is no hostname left in the request for
 *      a second DNS lookup to re-resolve.
 *   4. `redirect: 'manual'` - any 3xx is a hard failure (`ProbeFailedError`
 *      with code 'REDIRECTED'), following the exact pattern already proven
 *      in this repo for Ombi/Seerr (services/ombi.ts, services/seerr.ts):
 *      key off `response.type === 'opaqueredirect'` rather than reading the
 *      (fetch-spec-hidden) status/Location of a manually-blocked redirect.
 *   5. Bounded by a per-call timeout; the caller composes several calls under
 *      one shared total budget (see SETUP_TOTAL_BUDGET_MS in embySetupPlugin.ts).
 *   6. Throws only messages safe to return to a client: upstream status,
 *      status text and body are never included in the thrown MESSAGE
 *      (SEC-03c). Callers that want the detail for server-side logging get
 *      it via `onUpstreamError`. A non-ok response DOES throw the real
 *      status as data (`HttpClientError.statusCode` - CR-4 fix): the caller
 *      needs it to discriminate 401/403 from a genuine connection failure
 *      (EmbyClient.verifyServerAdmin/authenticate both branch on
 *      `error instanceof HttpClientError && error.statusCode === ...`,
 *      exactly what the plain, unhardened `fetchJson` path already throws -
 *      see utils/http.ts). Only the MESSAGE stays fixed and generic; the
 *      status code itself is not upstream prose.
 *
 * IMP-02: step 3's ORIGINALLY-intended mechanism - an undici `Agent` whose
 * `connect.lookup` pins the resolved+validated address, handed to the
 * global `fetch` as its `dispatcher` - was marked **inferred - unverified**
 * in the design and is now CONFIRMED BROKEN against this repo's actual
 * dependency versions, not merely unverified: Node's global `fetch`
 * validates a passed `dispatcher` against its OWN internally bundled
 * `undici`'s shape, and a directly-installed `undici` package instance
 * (`^8.2.0` here) never satisfies that check - every call throws
 * `InvalidArgumentError: invalid onRequestStart method`
 * (`UND_ERR_INVALID_ARG`), reproduced empirically before writing this fix.
 *
 * The documented fallback (request the literal IP with an explicit `Host`
 * header) turned out to have a SECOND empirically-confirmed problem: the
 * standard `fetch()` API treats `Host` as a forbidden request header (per
 * the WHATWG Fetch spec) and silently overrides it with the connection's
 * own address, so a plain `fetch(pinnedUrl, { headers: { Host: original } })`
 * never actually sends the original hostname either. Node's raw `http`/
 * `https` modules are NOT bound by that restriction - `http.request({
 * hostname: pinnedIp, headers: { Host: original } })` sends exactly the
 * `Host` given, independent of the connection address, and `https.request`
 * additionally accepts a `servername` option for TLS SNI, independent of
 * `hostname` too - both confirmed empirically. So the real fallback
 * (`pinnedNodeRequest` below) uses `node:http`/`node:https` directly rather
 * than `fetch()`, which fully resolves the SNI/virtual-hosting caveat the
 * spec's fallback clause anticipated, instead of merely documenting it.
 * safeProbe.test.ts's real-connect-pinning describe block exercises this
 * end to end (a local listener, no `fetchImpl` injected) and asserts the
 * original Host header actually arrives. The DNS-resolution +
 * address-validation steps (2) do not depend on any of this and hold
 * regardless.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpClientError, type HttpRequestOptions } from './http.js';
import { assertSafeProbeUrl, isDeniedProbeAddress, SsrfBlockedError } from './ssrf.js';

/**
 * NEW-02: hard cap on a probed response body. This module accumulates the
 * whole response in memory before handing it to the caller (`response.text`/
 * `.json()`), bounded only by the per-call timeout - on this pre-auth path
 * (the server the request lands on is client-supplied) an attacker who
 * controls the answering server can simply keep the connection open and
 * stream indefinitely for up to `timeoutMs`. 1 MiB is generous for the four
 * Emby endpoints this module actually probes (System/Info/Public, Users/Me,
 * Users/AuthenticateByName, the Plex equivalent) - all small JSON documents.
 * Clamped against THIS constant only, never against a `Content-Length` the
 * upstream reports (an attacker controls that header too).
 */
const MAX_PROBE_RESPONSE_BODY_BYTES = 1024 * 1024;

/** Thrown by the pre-flight checks (steps 1-2): the URL or its resolved address(es) are denied. */
export class ProbeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeBlockedError';
  }
}

/**
 * Thrown once the probe actually ran: network-level unreachability
 * (`UNREACHABLE`, e.g. connect/timeout/invalid-JSON failure - the fetch call
 * itself never completed with a response) or a blocked redirect
 * (`REDIRECTED`). A response that DID complete but came back non-ok (401,
 * 403, 500, ...) throws `HttpClientError` instead (CR-4 fix), carrying the
 * real `statusCode` so callers can discriminate an auth rejection from an
 * actual connection failure - see the file header, point 6.
 */
export class ProbeFailedError extends Error {
  readonly code: 'UNREACHABLE' | 'REDIRECTED';
  constructor(code: 'UNREACHABLE' | 'REDIRECTED', message: string) {
    super(message);
    this.name = 'ProbeFailedError';
    this.code = code;
  }
}

export interface SafeProbeOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Service name, only used for the server-side detail log, never echoed to the client. */
  service: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Shared budget across a caller's several calls - whichever fires first aborts. */
  signal?: AbortSignal;
  /** Server-side-only detail sink (status, status text, body) - never returned to a client. */
  onUpstreamError?: (detail: { status?: number; statusText?: string; body?: string }) => void;
}

export interface SafeProbeDeps {
  /** Defaults to `dns.promises.lookup(hostname, { all: true })`. Test seam. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /**
   * Defaults to `pinnedNodeRequest` (real `node:http`/`node:https`, address
   * pinning applied). Test seam - when supplied, no address pinning is
   * applied at all (the given function is called with the URL exactly as
   * given); only used in tests.
   */
  fetchImpl?: typeof fetch;
}

/** The subset of the Fetch API's `Response` this module actually consumes - satisfied by both a real `Response` (the test-seam `fetchImpl` path) and `pinnedNodeRequest`'s return value (the real path). */
interface MinimalResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  /** Fetch's manual-redirect marker, mirrored here for the real path (see `pinnedNodeRequest`) so both paths share the exact same `response.type === 'opaqueredirect'` check (file header, step 4). */
  readonly type: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  // AbortSignal.any is available on the Node runtime this repo targets (>=20).
  return AbortSignal.any(present);
}

/**
 * NR-2: races `promise` against `signal` and rejects generically the moment
 * the signal aborts, without waiting for `promise` itself to settle. Used to
 * bound `dns.lookup` (which accepts no signal of its own) by the same
 * per-probe timeout + shared budget the rest of the probe already honors.
 * Rejecting here does NOT cancel the underlying work - only the AWAIT - so a
 * background `dns.lookup` thread-pool call can still resolve after this
 * function has already thrown; the caller only cares that its own await
 * unblocks and the concurrency slot is released.
 */
function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ProbeFailedError('UNREACHABLE', 'Could not reach the server.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ProbeFailedError('UNREACHABLE', 'Could not reach the server.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Resolve `hostname` and validate every returned address. Throws
 * `ProbeBlockedError` if resolution fails, returns nothing, or any address
 * fails `isDeniedProbeAddress`.
 */
async function resolveAndValidate(
  hostname: string,
  lookup: NonNullable<SafeProbeDeps['lookup']>
): Promise<{ address: string; family: number }[]> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DNS resolution failed';
    throw new ProbeBlockedError(`Could not resolve ${hostname}: ${message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new ProbeBlockedError(`${hostname} did not resolve to any address`);
  }

  for (const { address } of addresses) {
    const reason = isDeniedProbeAddress(address);
    if (reason) {
      throw new ProbeBlockedError(
        `${hostname} resolves to a denied address (${address}): ${reason}`
      );
    }
  }

  return addresses;
}

/**
 * The real (non-test) request path (spec §8.2 step 3, IMP-02 fix): connects
 * directly to `pinnedAddress` (already validated by `resolveAndValidate`)
 * using `node:http`/`node:https`, never the target's hostname - carrying the
 * original `Host` header and, for https, the original TLS `servername` -
 * both confirmed to work via these raw modules where the standard `fetch()`
 * API silently does not (file header). Manual-redirect handling mirrors
 * `fetch({redirect:'manual'})`'s own `opaqueredirect` marker rather than
 * introducing a second convention: raw `http`/`https` never follow
 * redirects themselves, so any 3xx status is simply read directly off
 * `res.statusCode` here and reported the same way.
 */

/**
 * NR-3: tagged on a rejection's error object when the failure happened
 * BEFORE any response was received (a genuine connection-level failure -
 * refused/reset/timed-out/aborted at connect). Only a connection-level
 * failure is eligible for the caller's next-validated-address fallback; a
 * failure once a response has started arriving (a body read error, or
 * NEW-02's size clamp) is never retried.
 */
type ConnectionLevelError = Error & { isConnectionLevel?: boolean };

function isConnectionLevelError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isConnectionLevel?: unknown }).isConnectionLevel === true
  );
}

function pinnedNodeRequest(
  targetUrl: URL,
  pinnedAddress: { address: string; family: number },
  originalHost: string,
  originalHostname: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }
): Promise<MinimalResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;

    const headers: Record<string, string> = { ...(init.headers ?? {}), Host: originalHost };
    // NEW-03: without an explicit Content-Length, Node sends the body as
    // `Transfer-Encoding: chunked`. `/Users/AuthenticateByName` behind a
    // reverse proxy is the call that decides whether setup works at all, and
    // this repo's local Node test server accepts chunked transparently, so
    // nothing caught this locally. `Buffer.byteLength` (not `.length`) so a
    // non-ASCII password is not truncated.
    if (init.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(init.body));
    }

    let responseStarted = false;

    const req = transport.request(
      {
        hostname: pinnedAddress.address,
        port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: init.method,
        headers,
        // https only, and only when the original host is a real DNS name
        // (NEW-04): handing an IP literal to TLS SNI is forbidden by RFC 6066
        // - Node warns and may ignore it. Certificate validation is
        // unaffected either way: `checkServerIdentity` still matches the
        // connection against `originalHostname` via the request's `host`
        // fallback (or the certificate's IP subjectAltName when the target
        // itself is an IP-literal URL), independent of whether `servername`
        // was explicitly set here.
        ...(isHttps && !net.isIP(originalHostname) ? { servername: originalHostname } : {}),
      },
      (res) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let overflowed = false;
        res.on('data', (chunk: Buffer) => {
          if (overflowed) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_PROBE_RESPONSE_BODY_BYTES) {
            overflowed = true;
            req.destroy();
            rejectPromise(new ProbeFailedError('UNREACHABLE', 'Could not reach the server.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (overflowed) return;
          const status = res.statusCode ?? 0;
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            type: status >= 300 && status < 400 ? 'opaqueredirect' : 'basic',
            text: () => Promise.resolve(bodyText),
            json: () => Promise.resolve(JSON.parse(bodyText)),
          });
        });
        res.on('error', rejectPromise);
      }
    );

    req.on('error', (err: Error) => {
      if (!responseStarted) {
        (err as ConnectionLevelError).isConnectionLevel = true;
      }
      rejectPromise(err);
    });

    const onAbort = () => {
      req.destroy(init.signal.reason instanceof Error ? init.signal.reason : new Error('Aborted'));
    };
    if (init.signal.aborted) {
      onAbort();
    } else {
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => init.signal.removeEventListener('abort', onAbort));
    }

    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * The hardened fetch-and-parse-JSON primitive described in the file header.
 * `url` must already be the canonicalized origin the caller intends to
 * store/echo (see the setup plugin's canonicalization step) - this function
 * probes exactly the URL it is given and does no canonicalization itself.
 */
export async function safeProbeJson<T>(
  url: string,
  opts: SafeProbeOptions,
  deps: SafeProbeDeps = {}
): Promise<T> {
  // Step 1: literal pre-flight (scheme + address deny list on the URL as written).
  try {
    assertSafeProbeUrl(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw new ProbeBlockedError(err.message);
    throw err;
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // NR-2: build the combined per-probe + shared-budget signal BEFORE
  // resolving the hostname, and race resolution against it. Previously this
  // signal was built only AFTER `resolveAndValidate` returned, so a hanging
  // `dns.lookup` (an attacker-controlled resolver on this pre-auth path)
  // observed NEITHER bound and could hold one of only two concurrency slots
  // for a whole OS resolver retry cycle.
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = combineSignals(timeoutSignal, opts.signal);

  // Step 2: resolve + validate every address the hostname maps to, bounded by
  // `signal` above. Racing (rather than passing the signal INTO `lookup`,
  // which `dns.promises.lookup` does not accept) rejects the AWAIT the
  // moment the bound fires - releasing the caller's concurrency slot - even
  // though the underlying `dns.lookup` thread-pool work itself keeps running
  // in the background and cannot be truly cancelled.
  const lookupImpl =
    deps.lookup ?? (async (host: string) => dns.promises.lookup(host, { all: true }));
  const validatedAddresses = await raceAgainstAbort(
    resolveAndValidate(hostname, lookupImpl),
    signal
  );

  const fetchImpl = deps.fetchImpl;

  // Step 3 (spec §8.2/§8.3, IMP-02 fix): pin the connection to an address
  // already validated above - no second DNS query at connect time, so there
  // is no TOCTOU gap between the check and the connection actually made. See
  // the file header for why this uses `pinnedNodeRequest` (real `node:http`/
  // `node:https`) rather than the standard `fetch()` API when no test
  // `fetchImpl` is injected.
  let response: MinimalResponse | undefined;
  let lastErr: unknown;

  if (fetchImpl) {
    try {
      response = await fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        // Step 4: never follow a redirect - see file header for why 'manual'
        // plus response.type is the correct check rather than status/Location.
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      lastErr = err;
    }
  } else {
    // NR-3: a CONNECTION-LEVEL failure (refused/reset/timed-out before any
    // response arrived) on one validated address falls back to trying the
    // next one - `resolveAndValidate` pins to `validatedAddresses[0]` only,
    // so a dual-stack host whose first-sorted address happens to be
    // unreachable would otherwise report a false SERVER_UNREACHABLE even
    // though `/emby/login`'s plain, unpinned `fetch` (which lets the OS pick)
    // would have succeeded. A failure AFTER a response was already received
    // (a bad body, NEW-02's size clamp) is never retried - only the connect
    // step itself is considered unreliable enough to route around.
    for (let i = 0; i < validatedAddresses.length; i++) {
      try {
        response = await pinnedNodeRequest(parsed, validatedAddresses[i]!, parsed.host, hostname, {
          method: opts.method ?? 'GET',
          headers: opts.headers,
          body: opts.body,
          signal,
        });
        break;
      } catch (err) {
        lastErr = err;
        const hasMoreAddresses = i < validatedAddresses.length - 1;
        if (!isConnectionLevelError(err) || !hasMoreAddresses) break;
      }
    }
  }

  if (!response) {
    const message = lastErr instanceof Error ? lastErr.message : 'Unable to reach server';
    opts.onUpstreamError?.({ statusText: message });
    throw new ProbeFailedError('UNREACHABLE', 'Could not reach the server.');
  }

  if (response.type === 'opaqueredirect') {
    opts.onUpstreamError?.({ statusText: 'redirected' });
    throw new ProbeFailedError('REDIRECTED', 'The server responded with a redirect.');
  }

  if (!response.ok) {
    let body: string | undefined;
    try {
      body = await response.text();
    } catch {
      // ignore - body unavailable
    }
    opts.onUpstreamError?.({ status: response.status, statusText: response.statusText, body });
    // CR-4 fix: the real HTTP status has to reach the caller so it can
    // discriminate 401/403 from a genuine connection failure (EmbyClient's
    // verifyServerAdmin/authenticate both branch on
    // `error instanceof HttpClientError && error.statusCode === ...`, exactly
    // the class the plain, unhardened `fetchJson` path already throws here -
    // see utils/http.ts's assertResponseOk). `ProbeFailedError` carried no
    // status at all, so every non-ok response - including 401 and 403 -
    // collapsed into the same generic "unreachable" case. The MESSAGE stays
    // the fixed, safe string regardless of status (SEC-03c: upstream status
    // text and body are never echoed to the client); only `statusCode` is
    // populated from the real response, for server-side/caller logic only.
    throw new HttpClientError({
      service: opts.service,
      statusCode: response.status,
      statusText: response.statusText,
      url,
      message: 'Could not reach the server.',
    });
  }

  try {
    return (await response.json()) as T;
  } catch {
    opts.onUpstreamError?.({ statusText: 'invalid JSON response' });
    throw new ProbeFailedError('UNREACHABLE', 'Could not reach the server.');
  }
}

/**
 * Adapts `safeProbeJson` to the `(url, options?) => Promise<T>` shape the
 * media-server clients' JSON fetcher parameter expects (`EmbyJsonFetcher` in
 * emby/client.ts, the equivalent inline type on Plex's `verifyServerAdmin`),
 * so a caller can pass one bounded, hardened fetcher into either client
 * without duplicating the option-shape translation at every call site.
 */
export function asJsonFetcher(bounds: {
  timeoutMs: number;
  signal?: AbortSignal;
  onUpstreamError?: SafeProbeOptions['onUpstreamError'];
  deps?: SafeProbeDeps;
}): <T>(url: string, options?: HttpRequestOptions) => Promise<T> {
  return <T>(url: string, options?: HttpRequestOptions) =>
    safeProbeJson<T>(
      url,
      {
        method: options?.method,
        headers: options?.headers as Record<string, string> | undefined,
        body: typeof options?.body === 'string' ? options.body : undefined,
        service: options?.service ?? 'probe',
        timeoutMs: bounds.timeoutMs,
        signal: bounds.signal,
        onUpstreamError: bounds.onUpstreamError,
      },
      bounds.deps
    );
}
