import { UnrecoverableError } from 'bullmq';
import { assertSafeProbeUrl } from '../../../utils/ssrf.js';
import type { DeliverContext } from './types.js';

export const DELIVER_TIMEOUT_MS = 10_000;

/** Basic-auth embedded in the URL becomes an Authorization header. */
export function buildFetchOptions(rawUrl: string): {
  url: string;
  headers: Record<string, string>;
} {
  const parsed = new URL(rawUrl);
  const headers: Record<string, string> = {};
  if (parsed.username || parsed.password) {
    headers['Authorization'] =
      `Basic ${btoa(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`)}`;
    parsed.username = '';
    parsed.password = '';
  }
  return { url: parsed.toString(), headers };
}

/** SSRF policy first (link-local and non-web only; LAN/Tailscale/loopback allowed), then a timed request that throws on non-2xx. */
export async function deliverFetch(
  rawUrl: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
  ctx: DeliverContext
): Promise<void> {
  try {
    assertSafeProbeUrl(rawUrl);
  } catch (error) {
    throw new UnrecoverableError(
      `${ctx.destination.name}: ${error instanceof Error ? error.message : 'blocked url'}`
    );
  }
  const { url, headers } = buildFetchOptions(rawUrl);
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: ctx.signal,
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`${ctx.destination.name}: ${response.status} ${text}`.trim());
  }
}
