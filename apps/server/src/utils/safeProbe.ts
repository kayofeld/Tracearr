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
 *   3. Pin the connection to the already-validated addresses: the custom
 *      `connect.lookup` handed to undici's `Agent` returns the closure-
 *      captured, pre-validated address list instead of re-resolving, so
 *      there is no TOCTOU gap between the check and the connect.
 *   4. `redirect: 'manual'` - any 3xx is a hard failure (`ProbeFailedError`
 *      with code 'REDIRECTED'), following the exact pattern already proven
 *      in this repo for Ombi/Seerr (services/ombi.ts, services/seerr.ts):
 *      key off `response.type === 'opaqueredirect'` rather than reading the
 *      (fetch-spec-hidden) status/Location of a manually-blocked redirect.
 *   5. Bounded by a per-call timeout; the caller composes several calls under
 *      one shared total budget (see SETUP_TOTAL_BUDGET_MS in embySetupPlugin.ts).
 *   6. Throws only messages safe to return to a client: upstream status,
 *      status text and body are never included (SEC-03c). Callers that want
 *      the detail for server-side logging get it via `onUpstreamError`.
 *
 * The undici `Agent.connect.lookup` pinning (step 3) is the one piece the
 * design itself marks **inferred - unverified** (that undici's `connect`
 * options forward a custom `lookup` to `net`/`tls` in the Node runtime this
 * repo bundles, and that TLS SNI still carries the original hostname).
 * Verify with a build-time spike against a live server before relying on
 * this for a first production rollout with an untrusted network path; the
 * DNS-resolution + address-validation steps (2) do not depend on that
 * assumption and hold regardless.
 */

import dns from 'node:dns';
import { Agent } from 'undici';
import type { HttpRequestOptions } from './http.js';
import { assertSafeProbeUrl, isDeniedProbeAddress, SsrfBlockedError } from './ssrf.js';

/** Thrown by the pre-flight checks (steps 1-2): the URL or its resolved address(es) are denied. */
export class ProbeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeBlockedError';
  }
}

/** Thrown once the probe actually ran (steps 4-6): connection/redirect/parse failure. */
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
  /** Defaults to the global `fetch`. Test seam - when supplied, no undici Agent is built,
   *  so the resolved-address pinning (step 3) is bypassed; only used in tests. */
  fetchImpl?: typeof fetch;
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  // AbortSignal.any is available on the Node runtime this repo targets (>=20).
  return AbortSignal.any(present);
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

  // Step 2: resolve + validate every address the hostname maps to.
  const lookupImpl =
    deps.lookup ?? (async (host: string) => dns.promises.lookup(host, { all: true }));
  const validatedAddresses = await resolveAndValidate(hostname, lookupImpl);

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = combineSignals(timeoutSignal, opts.signal);

  const fetchImpl = deps.fetchImpl;
  // Step 3: pin the connection to the addresses already validated above - no
  // second DNS query at connect time, so there is no TOCTOU gap between the
  // check and the connection undici actually makes. Only built for the real
  // fetch path; an injected fetchImpl (tests) bypasses the Agent entirely.
  const dispatcher = fetchImpl
    ? undefined
    : new Agent({
        connect: {
          lookup: (
            _hostname: string,
            _options: unknown,
            callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
          ) => {
            const first = validatedAddresses[0];
            if (!first) {
              callback(new Error('No validated address available'), '', 0);
              return;
            }
            callback(null, first.address, first.family);
          },
        },
      });

  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      // Step 4: never follow a redirect - see file header for why 'manual'
      // plus response.type is the correct check rather than status/Location.
      redirect: 'manual',
      signal,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to reach server';
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
    throw new ProbeFailedError('UNREACHABLE', 'Could not reach the server.');
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
