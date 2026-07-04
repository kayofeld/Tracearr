/**
 * Plex connection testing helpers
 *
 * Shared by the Plex auth plugin (server selection during login) and the
 * owner-gated server management routes (available-servers, server-connections,
 * test-connection). Extracted so the login plugin and the Fastify routes use
 * one implementation.
 */

import type { PlexConnectionError, PlexDiscoveredConnection } from '@tracearr/shared';
import { plexHeaders } from '../../../utils/http.js';
import { assertSafeProbeUrl } from '../../../utils/ssrf.js';

// Connection testing timeout in milliseconds
export const CONNECTION_TEST_TIMEOUT = 3000;

/**
 * Categorize a fetch failure into a stable error code + human-readable detail.
 *
 * Maps undici/Node errors (`err.cause.code`) to a small enum the frontend can
 * render with translated labels. The `message` field carries the specifics
 * (hostname, TLS reason, etc.) so the UI can show them inline.
 */
export function categorizeConnectionError(err: unknown): PlexConnectionError {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { code: 'timeout', message: `Timed out after ${CONNECTION_TEST_TIMEOUT}ms` };
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    const detail = cause?.message ?? err.message;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { code: 'dns', message: detail };
    }
    if (code === 'ECONNREFUSED') {
      return { code: 'refused', message: detail };
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return { code: 'unreachable', message: detail };
    }
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
      return { code: 'reset', message: detail };
    }
    if (
      code &&
      (code.startsWith('CERT_') || code.startsWith('ERR_TLS_') || code.includes('SELF_SIGNED'))
    ) {
      return { code: 'tls', message: detail };
    }
    return { code: 'unknown', message: detail };
  }
  return { code: 'unknown', message: 'Connection failed' };
}

/**
 * Test a single connection URI. Shared by bulk discovery and the
 * single-URL test endpoint used to verify custom URLs before save.
 */
export async function testSingleConnection(
  conn: { uri: string; local: boolean; address: string; port: number; custom?: boolean },
  token: string
): Promise<PlexDiscoveredConnection> {
  const start = Date.now();
  try {
    assertSafeProbeUrl(conn.uri);
    const response = await fetch(`${conn.uri}/`, {
      headers: plexHeaders(token),
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT),
    });
    if (response.ok) {
      return {
        uri: conn.uri,
        local: conn.local,
        address: conn.address,
        port: conn.port,
        reachable: true,
        latencyMs: Date.now() - start,
        ...(conn.custom ? { custom: true } : {}),
      };
    }
    return {
      uri: conn.uri,
      local: conn.local,
      address: conn.address,
      port: conn.port,
      reachable: false,
      latencyMs: null,
      error: {
        code: 'http',
        message: `HTTP ${response.status} ${response.statusText}`.trim(),
        status: response.status,
      },
      ...(conn.custom ? { custom: true } : {}),
    };
  } catch (err) {
    return {
      uri: conn.uri,
      local: conn.local,
      address: conn.address,
      port: conn.port,
      reachable: false,
      latencyMs: null,
      error: categorizeConnectionError(err),
      ...(conn.custom ? { custom: true } : {}),
    };
  }
}

/**
 * Test connections to a Plex server and return results with reachability info
 */
export async function testServerConnections(
  connections: Array<{
    uri: string;
    local: boolean;
    address: string;
    port: number;
    relay: boolean;
  }>,
  token: string
): Promise<PlexDiscoveredConnection[]> {
  const results = await Promise.all(connections.map((conn) => testSingleConnection(conn, token)));

  // Sort: reachable first, then HTTPS, then local preference, then by latency
  return results.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    const aHttps = a.uri.startsWith('https://');
    const bHttps = b.uri.startsWith('https://');
    if (aHttps !== bHttps) return aHttps ? -1 : 1;
    if (a.local !== b.local) return a.local ? -1 : 1;
    if (a.latencyMs !== null && b.latencyMs !== null) {
      return a.latencyMs - b.latencyMs;
    }
    return 0;
  });
}
