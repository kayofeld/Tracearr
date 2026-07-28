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
 *     auth.ts's `hooks.before` (keyed on ctx.path), extended to this path.
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
 */

import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

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

export const signupPlugin = () =>
  ({
    id: 'signup',
    endpoints: {
      signUpUsername: createAuthEndpoint(
        '/sign-up/username',
        { method: 'POST', body: signUpUsernameBody },
        async (ctx) => {
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
          // this (and never can collide, see file header).
          if (email) {
            const existing = await ctx.context.internalAdapter.findUserByEmail(email);
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

          await ctx.context.internalAdapter.linkAccount({
            userId: createdUser.id,
            providerId: 'credential',
            accountId: createdUser.id,
            password: hash,
          });

          const session = await ctx.context.internalAdapter.createSession(createdUser.id);
          if (!session) {
            throw new APIError('BAD_REQUEST', { message: 'Failed to create session' });
          }
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
