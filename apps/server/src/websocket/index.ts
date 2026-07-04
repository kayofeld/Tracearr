/**
 * Socket.io WebSocket server setup
 */

import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { ServerToClientEvents, ClientToServerEvents, AuthUser } from '@tracearr/shared';
import { WS_EVENTS, REDIS_KEYS } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { db } from '../db/client.js';
import { mobileSessions } from '../db/schema.js';
import { resolveBetterAuthSession } from '../lib/sessionResolver.js';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface SocketData {
  user: AuthUser;
}

let io: TypedServer | null = null;
let redis: Redis | null = null;

/**
 * Verify JWT token for WebSocket connections
 */
function verifyToken(token: string): AuthUser {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }

  const decoded = jwt.verify(token, secret) as AuthUser;
  return decoded;
}

/**
 * Resolves the authenticated user for a Socket.io handshake: legacy JWT
 * first (mobile shim, old web tabs), then a Better Auth session (bearer
 * token or cookie). Any resolution error denies the connection (fail-closed).
 *
 * Better Auth bearer tokens carry no `deviceId`, so mobile status for those
 * sessions is derived by looking up `mobileSessions` by `betterAuthSessionId`;
 * a match means the connection is a paired mobile device (and needs the
 * blacklist check below), no match means it's a web session.
 */
export async function resolveSocketUser(handshake: {
  token: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}): Promise<AuthUser | null> {
  if (handshake.token) {
    try {
      return verifyToken(handshake.token);
    } catch {
      // fall through to better auth
    }
  }

  try {
    const headers = new Headers();
    if (handshake.token) headers.set('authorization', `Bearer ${handshake.token}`);
    const cookie = handshake.headers.cookie;
    if (cookie) headers.set('cookie', Array.isArray(cookie) ? cookie.join('; ') : cookie);

    const resolved = await resolveBetterAuthSession(headers);
    if (!resolved) return null;
    if (!resolved.sessionId) return resolved.user;

    const [mobileRow] = await db
      .select({ deviceId: mobileSessions.deviceId })
      .from(mobileSessions)
      .where(eq(mobileSessions.betterAuthSessionId, resolved.sessionId))
      .limit(1);

    if (!mobileRow) return resolved.user;
    return { ...resolved.user, mobile: true, deviceId: mobileRow.deviceId };
  } catch {
    return null;
  }
}

/**
 * Checks whether a mobile device's token has been blacklisted (revoked).
 * Fails closed: any Redis error denies the connection rather than letting
 * it through unverified.
 */
export async function checkMobileBlacklist(redisClient: Redis, deviceId: string): Promise<boolean> {
  try {
    const blacklisted = await redisClient.get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(deviceId));
    return !blacklisted;
  } catch (err) {
    console.error('[WebSocket] Blacklist check error:', err);
    return false;
  }
}

export function initializeWebSocket(
  httpServer: HttpServer,
  basePath = '',
  redisClient?: Redis
): TypedServer {
  if (redisClient) {
    redis = redisClient;
  }
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || true,
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    // When basePath is set, Socket.io must listen on the prefixed path.
    // Socket.io runs on the raw HTTP server (not Fastify), so rewriteUrl doesn't apply.
    ...(basePath && { path: `${basePath}/socket.io` }),
  });

  // Authentication middleware
  io.use((socket: TypedSocket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    const headers = socket.handshake.headers as Record<string, string | string[] | undefined>;

    resolveSocketUser({ token, headers })
      .then((user) => {
        if (!user) {
          next(new Error('Authentication failed'));
          return;
        }

        // Check if this mobile device's token has been blacklisted (revoked)
        if (user.mobile && user.deviceId && redis) {
          void checkMobileBlacklist(redis, user.deviceId).then((allowed) => {
            if (allowed) {
              (socket.data as SocketData).user = user;
              next();
            } else {
              next(new Error('Session has been revoked'));
            }
          });
          return;
        }

        (socket.data as SocketData).user = user;
        next();
      })
      .catch((error: unknown) => {
        console.error('[WebSocket] Auth error:', error);
        next(new Error('Authentication failed'));
      });
  });

  io.on('connection', (socket: TypedSocket) => {
    const user = (socket.data as SocketData).user;
    console.log(
      `[WebSocket] Client connected: ${socket.id} (user: ${user?.username ?? 'unknown'})`
    );

    // Join user-specific room for targeted messages
    if (user?.userId) {
      void socket.join(`user:${user.userId}`);
    }

    // Join device-specific room for mobile clients (enables targeted disconnect)
    if (user?.mobile && user?.deviceId) {
      void socket.join(`mobile:${user.deviceId}`);
    }

    // Join server rooms for server-specific messages
    if (user?.serverIds) {
      for (const serverId of user.serverIds) {
        void socket.join(`server:${serverId}`);
      }
    }

    // Auto-subscribe to sessions on connect
    void socket.join('sessions');

    // Handle session subscriptions
    socket.on(WS_EVENTS.SUBSCRIBE_SESSIONS as 'subscribe:sessions', () => {
      void socket.join('sessions');
      console.log(`[WebSocket] ${socket.id} subscribed to sessions`);
    });

    socket.on(WS_EVENTS.UNSUBSCRIBE_SESSIONS as 'unsubscribe:sessions', () => {
      void socket.leave('sessions');
      console.log(`[WebSocket] ${socket.id} unsubscribed from sessions`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WebSocket] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  });

  console.log('[WebSocket] Server initialized');
  return io;
}

export function getIO(): TypedServer {
  if (!io) {
    throw new Error('WebSocket server not initialized');
  }
  return io;
}

export function broadcastToSessions<K extends keyof ServerToClientEvents>(
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (io.to('sessions').emit as (event: K, ...args: Parameters<ServerToClientEvents[K]>) => void)(
      event,
      ...args
    );
  }
}

export function broadcastToServer<K extends keyof ServerToClientEvents>(
  serverId: string,
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (
      io.to(`server:${serverId}`).emit as (
        event: K,
        ...args: Parameters<ServerToClientEvents[K]>
      ) => void
    )(event, ...args);
  }
}

/**
 * Force-disconnect a specific mobile device's sockets.
 * Scans all connected sockets rather than relying on room membership.
 */
export function disconnectMobileDevice(deviceId: string): void {
  if (!io) return;
  for (const [, socket] of io.sockets.sockets) {
    const user = (socket.data as SocketData).user;
    if (user?.mobile && user.deviceId === deviceId) {
      socket.disconnect(true);
    }
  }
}

/**
 * Force-disconnect all mobile sockets for a user.
 */
export function disconnectAllMobileDevices(userId: string): void {
  if (!io) return;
  for (const [, socket] of io.sockets.sockets) {
    const user = (socket.data as SocketData).user;
    if (user?.mobile && user.userId === userId) {
      socket.disconnect(true);
    }
  }
}

export function broadcastToAll<K extends keyof ServerToClientEvents>(
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (io.emit as (event: K, ...args: Parameters<ServerToClientEvents[K]>) => void)(event, ...args);
  }
}
