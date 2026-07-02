import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username as usernamePlugin, admin as adminPlugin, bearer } from 'better-auth/plugins';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { Redis } from 'ioredis';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { getSetting } from '../services/settings.js';
import { requireBetterAuthSecret } from './env.js';
import { assertSignupAllowed, assertClaimCode, assertUserCanLogin } from './authGuards.js';

function buildAuth(redis: Redis) {
  const prefix = process.env.REDIS_PREFIX ?? '';
  const rkey = (k: string) => `${prefix}tracearr:ba:${k}`;

  return betterAuth({
    basePath: '/api/v1/auth',
    secret: requireBetterAuthSecret(),
    trustedOrigins: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    user: {
      fields: { image: 'thumbnail' },
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
        aggregateTrustScore: { type: 'number', required: false, defaultValue: 100, input: false },
        totalViolations: { type: 'number', required: false, defaultValue: 0, input: false },
        apiToken: { type: 'string', required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      storeSessionInDatabase: true,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    secondaryStorage: {
      get: async (key) => redis.get(rkey(key)),
      set: async (key, value, ttl) => {
        if (ttl) await redis.set(rkey(key), value, 'EX', ttl);
        else await redis.set(rkey(key), value);
      },
      delete: async (key) => {
        await redis.del(rkey(key));
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertSignupAllowed();
            return { data: { ...user, role: 'owner', emailVerified: true } };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            await assertUserCanLogin(session.userId);
            return { data: session };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email') {
          assertClaimCode((ctx.body as { claimCode?: string } | undefined)?.claimCode);
        }
        if (ctx.path === '/sign-in/email' || ctx.path === '/sign-in/username') {
          const localEnabled = await getSetting('localLoginEnabled');
          if (!localEnabled) {
            throw new APIError('FORBIDDEN', { message: 'Local login is disabled' });
          }
        }
      }),
    },
    plugins: [usernamePlugin(), adminPlugin({ adminRoles: ['owner'] }), bearer()],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let authInstance: Auth | null = null;
let redisClient: Redis | null = null;

/**
 * Returns the singleton Better Auth instance, constructing it (and its
 * Redis connection) on first call. Must not run at module load time -
 * Phase 1 startup (building the Fastify app) has to succeed without DB/Redis.
 */
export function getAuth(): Auth {
  if (authInstance) return authInstance;

  redisClient = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  authInstance = buildAuth(redisClient);
  return authInstance;
}

/**
 * Quits the Redis client backing the auth instance, if one was created.
 * Safe to call even when getAuth() was never invoked.
 */
export async function closeAuth(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  authInstance = null;
}
