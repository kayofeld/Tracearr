/**
 * Email-optional local sign-up (Better Auth plugin).
 *
 * Better Auth's built-in `POST /sign-up/email` hard-requires a valid email:
 * its body schema validates `email: z.email()` before any hook or handler
 * code runs (better-auth/dist/api/routes/sign-up.mjs), so that endpoint
 * cannot be made to accept a missing email - not via config, not via a
 * `databaseHooks.user.create.before` hook, because the schema rejects the
 * request before either fires. Tracearr is a self-hosted homelab tool with
 * no outbound mail configured, and the owner should not have to hand a
 * friend/family member an email account just to create a login - so this
 * plugin adds a sibling endpoint, `POST /sign-up/username`, that creates the
 * account through the *same* Better Auth primitives the built-in endpoint
 * uses, while allowing `email` to be omitted:
 *
 *   - `internalAdapter.createUser` runs the exact same `user.create` hook
 *     chain as `/sign-up/email` - our own hook (enforces single-owner
 *     sign-up via assertSignupAllowed, forces role/emailVerified) AND the
 *     username plugin's hook (format/length validation, case-insensitive
 *     uniqueness, normalization). Claim-code enforcement is centralized in
 *     auth.ts's `hooks.before` (keyed on ctx.path, via the shared
 *     SIGN_UP_USERNAME_PATH constant), extended to this path.
 *   - `internalAdapter.linkAccount` creates the credential (password) row,
 *     same as the built-in endpoint.
 *   - `internalAdapter.createSession` + `setSessionCookie` establish the
 *     session identically to every other local plugin endpoint in this
 *     codebase (see embyPlugin.ts / plexPlugin.ts).
 *
 * Email stays fully supported and optional, never removed: when supplied it
 * is validated, lower-cased, and checked for a pre-existing owner match (for
 * the same friendly-error behavior `/sign-up/email` gives); when omitted the
 * `users.email` column - already nullable (see db/schema.ts) - is left NULL,
 * never an empty string, so it can never collide with another NULL email
 * under `users_email_unique` (Postgres treats every NULL as distinct in a
 * unique index) and never falsely satisfies later `eq(users.email, '')`-style
 * matching.
 *
 * In practice this is Tracearr's only local sign-up path: assertSignupAllowed
 * permits exactly one local sign-up ever (the first-run owner), so
 * Login.tsx posts here unconditionally, whether or not the owner supplies an
 * email. `/sign-up/email` remains registered (emailAndPassword.enabled) for
 * any Better Auth internals or existing integration tests that target it
 * directly, but the frontend no longer calls it.
 *
 * Atomicity: `internalAdapter.createUser` commits its own row immediately -
 * nothing below it in this handler is transactional with it. A transient
 * failure in `linkAccount` or `createSession` would otherwise leave an owner
 * row with NO credential row: assertSignupAllowed then permits exactly one
 * local sign-up ever, so a retry gets 403 "already has an owner" and password
 * sign-in has no account to check against - the instance is permanently
 * locked out of local auth (recoverable only via Emby/OIDC sign-in or DB
 * surgery). `linkCredentialAndCreateSession` below compensates: on any
 * failure after the user row exists, it deletes that orphaned user (via
 * `internalAdapter.deleteUser`, which cascades sessions/accounts) so a retry
 * starts clean, then rethrows.
 */

import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { SIGN_UP_USERNAME_PATH } from '@tracearr/shared';
import { assertSignupAllowed } from './authGuards.js';

/** Blank form fields arrive as '' - treat them as "not provided", never as a value to validate. */
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

const signUpUsernameBody = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  email: z.preprocess(blankToUndefined, z.email().optional()),
  claimCode: z.preprocess(blankToUndefined, z.string().optional()),
});

/**
 * The exact fields to hand to internalAdapter.createUser: `email` is included
 * only when a non-blank value was supplied, and is always lower-cased -
 * never an empty string. Pure and exported so the no-email/with-email shape
 * is unit-testable without a Better Auth or database instance.
 */
export function buildSignupUserInput(input: { name: string; username: string; email?: string }): {
  name: string;
  username: string;
  email?: string;
} {
  const trimmedEmail = input.email?.trim();
  return {
    name: input.name,
    username: input.username,
    ...(trimmedEmail ? { email: trimmedEmail.toLowerCase() } : {}),
  };
}

/** Shape we return to the client - deliberately narrower than the full users row. */
interface SignedUpUser {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: string;
}

type SignupEndpointCtx = Parameters<typeof setSessionCookie>[0];

/** Just the internalAdapter surface linkCredentialAndCreateSession needs. */
type SignupInternalAdapter = SignupEndpointCtx['context']['internalAdapter'];
type CredentialAdapter = Pick<
  SignupInternalAdapter,
  'linkAccount' | 'createSession' | 'deleteUser'
>;

/** Minimal logger surface, so tests can pass a plain vi.fn() stub. */
interface SignupLogger {
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Links the password credential to `userId` and creates its session -
 * everything after `internalAdapter.createUser` has already committed the
 * user row. Neither call is transactional with that row's creation, so on
 * any failure here (linkAccount throwing, or createSession returning falsy)
 * this deletes the now-orphaned user before rethrowing - see the file header
 * for why an orphaned owner-with-no-credential row permanently locks the
 * instance out of local auth otherwise. Exported and adapter-injected so the
 * compensation path is unit-testable without a Better Auth or database
 * instance (see signupPlugin.test.ts).
 */
export async function linkCredentialAndCreateSession(
  adapter: CredentialAdapter,
  params: { userId: string; passwordHash: string },
  logger: SignupLogger
): Promise<Awaited<ReturnType<CredentialAdapter['createSession']>>> {
  try {
    await adapter.linkAccount({
      userId: params.userId,
      providerId: 'credential',
      accountId: params.userId,
      password: params.passwordHash,
    });

    const session = await adapter.createSession(params.userId);
    if (!session) {
      // The request was valid and the user row now exists - a null session
      // here is a server-side fault (e.g. a transient DB/Redis error), not a
      // client mistake, so this is INTERNAL_SERVER_ERROR, not BAD_REQUEST.
      throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create session' });
    }
    return session;
  } catch (err) {
    await adapter.deleteUser(params.userId).catch((cleanupErr: unknown) => {
      logger.error('Failed to compensate for incomplete sign-up (orphaned user)', cleanupErr);
    });
    if (err instanceof APIError) throw err;
    logger.error('Failed to link credential / create session', err);
    throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to complete sign-up' });
  }
}

export const signupPlugin = () =>
  ({
    id: 'signup',
    endpoints: {
      signUpUsername: createAuthEndpoint(
        SIGN_UP_USERNAME_PATH,
        { method: 'POST', body: signUpUsernameBody },
        async (ctx) => {
          // SR-05: check ownership before anything else - including the
          // findUserByEmail pre-check below - so a post-setup probe always
          // gets the same 403 once an owner exists, regardless of whether
          // the supplied email happens to match the owner's. Otherwise a 422
          // "email already exists" vs a 403 becomes an email-existence
          // oracle. internalAdapter.createUser's own user.create hook runs
          // this same check again (defense in depth against a signup that
          // lands concurrently between the two calls).
          await assertSignupAllowed();

          const { name, username, password, email } = ctx.body;

          const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
          if (password.length < minPasswordLength) {
            throw new APIError('BAD_REQUEST', { message: 'Password is too short' });
          }
          if (password.length > maxPasswordLength) {
            throw new APIError('BAD_REQUEST', { message: 'Password is too long' });
          }

          // Mirrors /sign-up/email's pre-check: a friendly 422 instead of a
          // raw users_email_unique violation surfacing as a 500. Only runs
          // when an email was actually supplied - omitting one never hits
          // this (and never can collide, see file header). Looked up
          // lower-cased to match how buildSignupUserInput stores it below -
          // otherwise a case-differing duplicate (Owner@x.com vs
          // owner@x.com) misses this friendly check and falls through to the
          // generic 422 from the unique-constraint violation instead.
          if (email) {
            const existing = await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase());
            if (existing?.user) {
              throw new APIError('UNPROCESSABLE_ENTITY', {
                message: 'A user with this email already exists',
              });
            }
          }

          const hash = await ctx.context.password.hash(password);

          let createdUser: SignedUpUser;
          try {
            // internalAdapter.createUser's TS type requires `email: string`
            // (better-auth's base User schema has no nullable-email variant),
            // but nothing at runtime requires the key: the hook chain and the
            // drizzle adapter both handle a missing/undefined email fine
            // (see db/schema.ts - the column has no NOT NULL/default). The
            // cast documents that mismatch instead of widening the parameter
            // type app-wide.
            createdUser = (await ctx.context.internalAdapter.createUser(
              buildSignupUserInput({ name, username, email }) as Parameters<
                typeof ctx.context.internalAdapter.createUser
              >[0]
            )) as unknown as SignedUpUser;
          } catch (err) {
            if (err instanceof APIError) throw err;
            ctx.context.logger.error('Failed to create user', err);
            throw new APIError('UNPROCESSABLE_ENTITY', { message: 'Failed to create user' });
          }
          if (!createdUser) {
            throw new APIError('UNPROCESSABLE_ENTITY', { message: 'Failed to create user' });
          }

          const session = await linkCredentialAndCreateSession(
            ctx.context.internalAdapter,
            { userId: createdUser.id, passwordHash: hash },
            ctx.context.logger
          );

          await setSessionCookie(ctx as SignupEndpointCtx, {
            session,
            user: createdUser as unknown as Parameters<typeof setSessionCookie>[1]['user'],
          });

          return ctx.json({
            token: session.token,
            user: {
              id: createdUser.id,
              username: createdUser.username,
              name: createdUser.name,
              email: createdUser.email ?? null,
              role: createdUser.role,
            },
          });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
