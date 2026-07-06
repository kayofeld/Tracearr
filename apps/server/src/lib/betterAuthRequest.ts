import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth, CLIENT_IP_HEADER } from './auth.js';

function firstForwardedValue(header: string | string[] | undefined): string | undefined {
  return (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
}

/**
 * Client-facing scheme for a request, from x-forwarded-proto (validated
 * http/https, first value of a comma list) falling back to the socket
 * protocol. Shared by the URL Better Auth derives its origin from and by the
 * per-request cookie Secure flag in createBetterAuthHandler, so the two can
 * never disagree.
 */
export function deriveScheme(request: FastifyRequest): string {
  const proto = firstForwardedValue(request.headers['x-forwarded-proto']);
  return proto === 'https' || proto === 'http' ? proto : request.protocol;
}

/**
 * Adapts a Fastify request into a fetch Request for the Better Auth handler.
 *
 * Better Auth has no baseURL configured, so it derives its per-request
 * trusted origin from this URL. Behind a TLS-terminating reverse proxy the
 * scheme must reflect the client-facing protocol (x-forwarded-proto) or the
 * derived origin is http://host while the browser sends Origin: https://host,
 * and every cookie-bearing request fails with 403 INVALID_ORIGIN. Likewise a
 * proxy that rewrites Host to the upstream address must have its
 * x-forwarded-host honored or the derived origin's host can never match the
 * browser Origin. Trusting x-forwarded-proto and x-forwarded-host is safe
 * against the browser CSRF threat model: a cross-site page cannot attach
 * either header (and already controls neither Host nor its own Origin), and
 * a direct request that forges them still has to present an Origin matching
 * the derived origin, which a cross-site page cannot send.
 */
export function toWebRequest(request: FastifyRequest): Request {
  const host = firstForwardedValue(request.headers['x-forwarded-host']) || request.headers.host;
  const url = new URL(request.url, `${deriveScheme(request)}://${host}`);
  const headers = fromNodeHeaders(request.headers);
  // Better Auth trusts this header unconditionally for rate limiting and
  // session.ipAddress, so it must be set (never appended) after the inbound
  // headers are copied: an attacker-supplied copy cannot survive. Should
  // request.ip ever be unavailable, dropping the header leaves Better Auth
  // on its no-ip default (shared bucket), no worse than an unset header.
  if (request.ip) {
    headers.set(CLIENT_IP_HEADER, request.ip);
  } else {
    headers.delete(CLIENT_IP_HEADER);
  }
  return new Request(url.toString(), {
    method: request.method,
    headers,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
}

function hasSecureAttribute(cookie: string): boolean {
  return /;\s*secure\s*(;|$)/i.test(cookie);
}

type BetterAuthHandlerSource = () => { handler: (request: Request) => Promise<Response> };

/**
 * Fastify handler for the Better Auth wildcard mount (GET/POST
 * /api/v1/auth/*). index.ts registers it against the getAuth() singleton;
 * test harnesses register this same function (optionally against a
 * purpose-built auth instance) so they exercise this exact code path rather
 * than a copy.
 */
export function createBetterAuthHandler(source: BetterAuthHandlerSource = getAuth) {
  return async function betterAuthHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const response = await source().handler(toWebRequest(request));
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() === 'set-cookie') continue;
        reply.header(key, value);
      }
      // Better Auth mints cookies with useSecureCookies pinned false
      // (lib/auth.ts), so the Secure attribute is decided here, per request:
      // https requests get it appended, http requests get a cookie a browser
      // will actually keep. getSetCookie() keeps multiple cookies as separate
      // header values; iterating response.headers must not, so set-cookie is
      // skipped above and emitted once as an array.
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) {
        const secure = deriveScheme(request) === 'https';
        reply.header(
          'set-cookie',
          secure ? setCookies.map((c) => (hasSecureAttribute(c) ? c : `${c}; Secure`)) : setCookies
        );
      }
      return await reply.send(response.body ? await response.text() : null);
    } catch (error) {
      request.log.error({ err: error }, 'better auth handler error');
      return reply.status(500).send({ error: 'Internal authentication error' });
    }
  };
}
