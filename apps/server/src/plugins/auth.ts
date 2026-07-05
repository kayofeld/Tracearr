/**
 * Authentication plugin for Fastify
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { REDIS_KEYS, CACHE_TTL } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, mobileSessions } from '../db/schema.js';
import { getSetting } from '../services/settings.js';
import { resolveBetterAuthUser } from '../lib/sessionResolver.js';
import { hashSha256 } from '../utils/hash.js';

// Module-level cache - populated at startup and refreshed after restore
let _jwtRevokedBefore: number | null = null; // Unix timestamp (seconds)

export async function loadJwtRevokeSettings(): Promise<void> {
  const val = await getSetting('jwtRevokedBefore');
  _jwtRevokedBefore = val ? Math.floor(new Date(val).getTime() / 1000) : null;
}

function isTokenRevoked(iat: number | undefined): boolean {
  return _jwtRevokedBefore !== null && iat !== undefined && iat < _jwtRevokedBefore;
}

// Public API token prefix
const PUBLIC_API_TOKEN_PREFIX = 'trr_pub_';

// Context attached to public API requests
export interface PublicApiContext {
  userId: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireMobile: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticatePublicApi: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    publicApiContext?: PublicApiContext;
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await app.register(jwt, {
    secret,
    sign: {
      algorithm: 'HS256',
    },
    cookie: {
      cookieName: 'token',
      signed: false,
    },
  });

  // Authenticate decorator - resolves a Better Auth session first, falling
  // back to legacy JWT verification (the mobile shim)
  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    const baUser = await resolveBetterAuthUser(request);
    if (baUser) {
      request.user = baUser;
      return;
    }
    try {
      await request.jwtVerify();
      if (isTokenRevoked((request.user as AuthUser & { iat?: number }).iat)) {
        return reply.unauthorized('Session invalidated. Please log in again');
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Require owner role decorator - same dual-verify as authenticate, plus role check
  app.decorate('requireOwner', async function (request: FastifyRequest, reply: FastifyReply) {
    const baUser = await resolveBetterAuthUser(request);
    if (baUser) {
      request.user = baUser;
      if (baUser.role !== 'owner') {
        return reply.forbidden('Owner access required');
      }
      return;
    }
    try {
      await request.jwtVerify();
      if (isTokenRevoked((request.user as AuthUser & { iat?: number }).iat)) {
        return reply.unauthorized('Session invalidated. Please log in again');
      }
      if (request.user.role !== 'owner') {
        reply.forbidden('Owner access required');
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Require mobile token decorator - dual-verify: legacy mobile JWTs first,
  // then Better Auth bearer tokens mapped to a paired device via
  // mobileSessions.refreshTokenHash. Both paths enforce the device blacklist
  // and the throttled lastSeenAt update, and both fail closed.
  app.decorate('requireMobile', async function (request: FastifyRequest, reply: FastifyReply) {
    let legacyVerified = false;
    try {
      await request.jwtVerify();
      legacyVerified = true;
    } catch {
      // Not a legacy JWT - fall through to the Better Auth bearer path
    }

    if (legacyVerified) {
      try {
        if (isTokenRevoked((request.user as AuthUser & { iat?: number }).iat)) {
          return reply.unauthorized('Session invalidated. Please log in again');
        }

        if (!request.user.mobile) {
          reply.forbidden('Mobile access token required');
          return;
        }

        // Check if this device's token has been blacklisted (session revoked)
        if (request.user.deviceId) {
          const blacklisted = await app.redis.get(
            REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(request.user.deviceId)
          );
          if (blacklisted) {
            reply.unauthorized('Session has been revoked');
            return;
          }

          // Throttled lastSeenAt update - at most once per CACHE_TTL.MOBILE_LAST_SEEN
          const throttleKey = REDIS_KEYS.MOBILE_LAST_SEEN(request.user.deviceId);
          const alreadyRecent = await app.redis.get(throttleKey);
          if (!alreadyRecent) {
            await app.redis.set(throttleKey, '1', 'EX', CACHE_TTL.MOBILE_LAST_SEEN);
            db.update(mobileSessions)
              .set({ lastSeenAt: new Date() })
              .where(eq(mobileSessions.deviceId, request.user.deviceId))
              .catch(() => undefined);
          }
        }
      } catch {
        reply.unauthorized('Invalid or expired token');
      }
      return;
    }

    // Better Auth bearer path: the pair endpoint hands the app a Better Auth
    // session token and stores its sha256 hash on the mobileSessions row, so
    // a resolved session plus a matching row identifies the paired device.
    try {
      const baUser = await resolveBetterAuthUser(request);
      if (!baUser) {
        return reply.unauthorized('Invalid or expired token');
      }

      const authHeader = request.headers.authorization ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token) {
        return reply.unauthorized('Mobile access token required');
      }

      const [row] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.refreshTokenHash, hashSha256(token)))
        .limit(1);
      if (!row) {
        return reply.forbidden('Mobile access token required');
      }

      const blacklisted = await app.redis.get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(row.deviceId));
      if (blacklisted) {
        return reply.unauthorized('Session has been revoked');
      }

      const throttleKey = REDIS_KEYS.MOBILE_LAST_SEEN(row.deviceId);
      const alreadyRecent = await app.redis.get(throttleKey);
      if (!alreadyRecent) {
        await app.redis.set(throttleKey, '1', 'EX', CACHE_TTL.MOBILE_LAST_SEEN);
        db.update(mobileSessions)
          .set({ lastSeenAt: new Date() })
          .where(eq(mobileSessions.deviceId, row.deviceId))
          .catch(() => undefined);
      }

      request.user = { ...baUser, mobile: true, deviceId: row.deviceId };
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Public API authentication - validates bearer token from Authorization header
  app.decorate(
    'authenticatePublicApi',
    async function (request: FastifyRequest, reply: FastifyReply) {
      const authHeader = request.headers.authorization;

      if (!authHeader?.startsWith('Bearer ')) {
        return reply.unauthorized('Missing or invalid Authorization header');
      }

      const token = authHeader.slice(7); // Remove "Bearer "

      if (!token.startsWith(PUBLIC_API_TOKEN_PREFIX)) {
        return reply.unauthorized('Invalid API key format');
      }

      // Find user with matching token
      const [user] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.apiToken, token))
        .limit(1);

      if (!user) {
        return reply.unauthorized('Invalid API key');
      }

      if (user.role !== 'owner') {
        return reply.forbidden('API key is not associated with an owner account');
      }

      // Attach context for use in route handlers
      request.publicApiContext = { userId: user.id };
    }
  );
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});
