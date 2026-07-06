import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  username as usernamePlugin,
  admin as adminPlugin,
  bearer,
  genericOAuth,
} from 'better-auth/plugins';
import { adminAc } from 'better-auth/plugins/admin/access';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import type { Redis } from 'ioredis';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { getSetting } from '../services/settings.js';
import { requireBetterAuthSecret } from './env.js';
import { assertSignupAllowed, assertClaimCode, assertUserCanLogin } from './authGuards.js';
import { getRedis, closeRedis } from './redisShared.js';
import { plexPlugin } from './plexPlugin.js';

const oidcEnv = {
  issuer: process.env.OIDC_ISSUER_URL,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
};

/** True only when all three required OIDC env vars are set. Config-gates the genericOAuth plugin. */
export const oidcConfigured = !!(oidcEnv.issuer && oidcEnv.clientId && oidcEnv.clientSecret);

/**
 * The only header Better Auth reads the client IP from
 * (advanced.ipAddress.ipAddressHeaders below). toWebRequest() in
 * betterAuthRequest.ts stamps it from Fastify's trustProxy-resolved
 * request.ip, overwriting any inbound copy so clients cannot pick their own
 * rate-limit bucket or forge session.ipAddress.
 */
export const CLIENT_IP_HEADER = 'x-tracearr-client-ip';

// TTL only on creation: the rate-limit window is fixed from first hit, later
// increments must not slide it. Lua instead of EXPIRE NX (7.0+) or GETDEL
// (6.2+) because self-hosted Redis versions vary and the repo documents no
// minimum; scripts run on anything 2.6+.
const INCREMENT_SCRIPT = `local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value`;

const GET_AND_DELETE_SCRIPT = `local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;

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
    advanced: {
      ipAddress: {
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
      database: {
        // users.id is a uuid column; the default id generator mints a nanoid
        // that Postgres rejects (22P02). A function generateId keeps Better
        // Auth minting the id in app code (unlike the "uuid" literal, which on
        // pg defers to a DB default the text-id auth_ tables don't have) and
        // emits a UUID valid for both the uuid and text id columns.
        generateId: () => randomUUID(),
      },
    },
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
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['oidc'],
      },
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
      increment: async (key, ttl) => {
        const value = await redis.eval(INCREMENT_SCRIPT, 1, rkey(key), ttl);
        return Number(value);
      },
      getAndDelete: async (key) =>
        (await redis.eval(GET_AND_DELETE_SCRIPT, 1, rkey(key))) as string | null,
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
    plugins: [
      usernamePlugin(),
      // adminRoles must have a matching entry in `roles` - the admin plugin
      // validates adminRoles against Object.keys(roles ?? { admin, user })
      // at construction time and throws BetterAuthError otherwise. Only
      // 'owner' needs admin powers today; admin/viewer/member/disabled/
      // pending (see schema.ts users.role) never reach this plugin.
      adminPlugin({ adminRoles: ['owner'], roles: { owner: adminAc } }),
      bearer(),
      plexPlugin(),
      ...(oidcConfigured
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'oidc',
                  clientId: oidcEnv.clientId!,
                  clientSecret: oidcEnv.clientSecret!,
                  discoveryUrl: `${oidcEnv.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`,
                  scopes: ['openid', 'email', 'profile'],
                  pkce: true,
                },
              ],
            }),
          ]
        : []),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let authInstance: Auth | null = null;

/**
 * Returns the singleton Better Auth instance, constructing it (and its
 * Redis connection) on first call. Must not run at module load time -
 * Phase 1 startup (building the Fastify app) has to succeed without DB/Redis.
 */
export function getAuth(): Auth {
  if (authInstance) return authInstance;

  authInstance = buildAuth(getRedis());
  return authInstance;
}

/**
 * Quits the shared Redis client backing the auth instance.
 * Safe to call even when getAuth() was never invoked.
 */
export async function closeAuth(): Promise<void> {
  await closeRedis();
  authInstance = null;
}
