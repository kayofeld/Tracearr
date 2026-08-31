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
import { LOGIN_ROLES, SIGN_UP_USERNAME_PATH, EMBY_SETUP_PATH } from '@tracearr/shared';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { getSetting } from '../services/settings.js';
import { requireBetterAuthSecret } from './env.js';
import {
  assertSignupAllowed,
  assertClaimCode,
  assertUserCanLogin,
  assertOAuthSignupClaimCode,
} from './authGuards.js';
import { getRedis, closeRedis } from './redisShared.js';
import { embyPlugin } from './embyPlugin.js';
import { embySetupPlugin, SETUP_RATE_LIMIT } from './embySetupPlugin.js';
import { signupPlugin } from './signupPlugin.js';
import { betterAuthBasePath } from './basePath.js';

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

/**
 * Per-request trusted origins for Better Auth's CSRF origin check.
 *
 * With no baseURL configured, Better Auth trusts only the origin it derives
 * from the request URL the shim builds (scheme included). Behind an HTTPS
 * proxy that does not forward x-forwarded-proto that derived origin is
 * http://host while the browser sends Origin: https://host, and every login
 * fails 403 INVALID_ORIGIN. Trusting BOTH schemes of the request's OWN host
 * fixes that without any user-side change. It only relaxes the scheme
 * distinction on the same host: a cross-site attacker page sends an Origin
 * with a different host and still fails the exact-match compare. The Origin
 * header itself must never be added here. Scheme security against an active
 * downgrade is owned by TLS/HSTS and the cookie Secure flag, not by this
 * check.
 *
 * Better Auth also invokes this at construction time with request ===
 * undefined (create-context), so the request guard is load-bearing.
 */
export function trustedOriginsForRequest(request?: Request): string[] {
  const origins = process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [];
  if (request) {
    try {
      const { host } = new URL(request.url);
      origins.push(`http://${host}`, `https://${host}`);
    } catch {
      // unparseable request URL: fall back to the static list
    }
  }
  return origins;
}

/**
 * The username plugin resolves sign-in (and username-taken checks) with an
 * unconstrained findOne on users.username. The users table also holds member
 * rows synced from media servers with arbitrary usernames, so a member whose
 * stored username equals a login username can be the row findOne returns and
 * silently break the real user's username/password login (the member has no
 * credential account, and the session hook rejects non-login roles anyway).
 * A username is only a login identifier for login-capable roles, exactly the
 * scope of the users_login_username_unique partial index, so every
 * user-by-username lookup is narrowed to those roles here. The plugin offers
 * no option for this, hence the adapter wrap.
 */
function withLoginScopedUsernameLookup(
  factory: ReturnType<typeof drizzleAdapter>
): ReturnType<typeof drizzleAdapter> {
  return (options) => {
    const adapter = factory(options);
    const findOne: typeof adapter.findOne = (data) => {
      if (
        data.model === 'user' &&
        data.where.some((w) => w.field === 'username') &&
        !data.where.some((w) => w.field === 'role')
      ) {
        return adapter.findOne({
          ...data,
          where: [
            ...data.where,
            { field: 'role', operator: 'in', value: [...LOGIN_ROLES], connector: 'AND' },
          ],
        });
      }
      return adapter.findOne(data);
    };
    return { ...adapter, findOne };
  };
}

interface BuildAuthOptions {
  /**
   * Enable Better Auth's built-in rate limiter. Defaults to `true` - this is
   * a security control, so it must be switchable only by an explicit,
   * typed option that a caller opts INTO passing, never by an environment
   * variable Better Auth reads implicitly (its own default is
   * `options.rateLimit?.enabled ?? isProduction`, i.e. NODE_ENV-derived - see
   * create-context.mjs). A deployment that forgets to set NODE_ENV=production
   * (or sets it to something else) must not silently lose the limiter.
   * Integration/unit test suites that drive several requests through one
   * Better Auth instance in-process pass `{ rateLimit: false }` explicitly
   * (see getAuth() below and signupPlugin.test.ts) so a real per-IP counter
   * doesn't trip on unrelated requests in the same test file.
   */
  rateLimit?: boolean;
}

function buildAuth(redis: Redis, options: BuildAuthOptions = {}) {
  const { rateLimit: rateLimitEnabled = true } = options;
  const prefix = process.env.REDIS_PREFIX ?? '';
  const rkey = (k: string) => `${prefix}tracearr:ba:${k}`;

  return betterAuth({
    // Better Auth builds its baseURL, and from it the OIDC redirect_uri, as
    // request origin plus this path, so it must include BASE_PATH.
    basePath: betterAuthBasePath(),
    secret: requireBetterAuthSecret(),
    trustedOrigins: trustedOriginsForRequest,
    database: withLoginScopedUsernameLookup(
      drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: schema.users,
          session: schema.authSessions,
          account: schema.authAccounts,
          verification: schema.authVerifications,
        },
      })
    ),
    advanced: {
      // Better Auth decides the cookie Secure flag (and the __Secure- name
      // prefix) once at init from NODE_ENV, so in production every cookie
      // would be Secure and browsers would drop it on plain-http LAN
      // deployments. Pin it off; createBetterAuthHandler appends Secure per
      // request when the derived scheme is https, so HTTPS deployments still
      // get the flag. http gets a cookie without Secure, same as the legacy
      // cookie system.
      useSecureCookies: false,
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
        // Kept deliberately. Authentik hardcodes email_verified:false since
        // 2025.10 and Keycloak defaults it false for admin-created users, so
        // requiring the claim breaks OIDC linking on the IdPs self-hosters
        // actually run. The operator owns both ends here; a shared or
        // self-registration IdP is the case this does not defend against.
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
      // See BuildAuthOptions.rateLimit above: this is an explicit, typed
      // knob (defaulting to enabled), never an environment-variable gate.
      enabled: rateLimitEnabled,
      storage: 'secondary-storage',
      // Per-path override for /emby/setup (SEC-07 fix,
      // emby-native-setup.md §9): the global default (max: 1000/min at the
      // Fastify layer, see index.ts) is not a meaningful bound for a path
      // that can hold several sequential outbound waits open. Verified
      // against the installed better-auth@1.6.23's actual customRules
      // matching (exact-path or wildcard key on the post-basePath path,
      // api/rate-limiter/index.mjs) rather than assumed from the type only.
      customRules: {
        [EMBY_SETUP_PATH]: SETUP_RATE_LIMIT,
      },
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
        // Both local sign-up variants (email-required core endpoint, and the
        // email-optional /sign-up/username from signupPlugin) gate on the
        // same claim code - centralized here rather than duplicated in the
        // plugin, matching how the built-in endpoint's own handler carries
        // no claim-code logic either.
        if (
          ctx.path === '/sign-up/email' ||
          ctx.path === SIGN_UP_USERNAME_PATH ||
          ctx.path === EMBY_SETUP_PATH
        ) {
          assertClaimCode((ctx.body as { claimCode?: string } | undefined)?.claimCode);
        }
        if (ctx.path === '/sign-in/oauth2') {
          const body = ctx.body as { additionalData?: { claimCode?: string } } | undefined;
          await assertOAuthSignupClaimCode(body?.additionalData?.claimCode);
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
      embyPlugin(),
      embySetupPlugin(),
      signupPlugin(),
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
 *
 * `options` only takes effect on the call that performs the first
 * construction (singleton) - later calls in the same process return the
 * already-built instance regardless of what they pass. Production code never
 * passes `options`; only test suites that need to disable the rate limiter
 * for an in-process multi-request run do (after `closeAuth()` has reset the
 * singleton), and they own the singleton lifecycle within that test file.
 */
export function getAuth(options?: BuildAuthOptions): Auth {
  if (authInstance) return authInstance;

  authInstance = buildAuth(getRedis(), options);
  return authInstance;
}

/**
 * Drops the auth instance so the next getAuth() rebuilds it, and quits the
 * fallback Redis client if one was created. The Fastify plugin's client is left
 * alone - its own onClose hook owns it.
 */
export async function closeAuth(): Promise<void> {
  await closeRedis();
  authInstance = null;
}
