/**
 * Emby credential login (Better Auth plugin).
 *
 * Single endpoint POST /emby/login. The owner signs in with their Emby
 * username/password; we authenticate against the configured Emby server, require
 * the account to be an Emby administrator, and map it to Tracearr's single owner
 * user. The Emby identity is bound to the owner in auth_accounts (provider 'emby')
 * so subsequent logins must be the same Emby account.
 *
 * This is owner-only by design (Tracearr is single-owner). Local email/password
 * login stays enabled as a recovery path — this plugin only adds a login method,
 * it does not remove one. The session `create` DB hook still runs
 * assertUserCanLogin as the final gate.
 *
 * Mirrors plexPlugin.ts; Emby is simpler (direct credentials, no OAuth PIN).
 */

import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { EMBY_LOGIN_FAILURE_REASONS, type EmbyLoginFailureReason } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, servers, authAccounts } from '../db/schema.js';
import { EmbyClient } from '../services/mediaServer/index.js';

export const EMBY_PROVIDER = 'emby';

// NOTE: the server URL is NEVER taken from the client. It is resolved from the
// owner's own configured Emby server. Accepting a client URL would let an
// attacker point login at their OWN Emby (where they are trivially admin),
// satisfy the isAdmin gate, and get bound as the Tracearr owner (auth bypass),
// as well as drive SSRF. Only credentials are accepted here.
const loginBody = z.object({
  username: z.string().min(1),
  password: z.string(),
});

// Bounds the best-effort admin-API lookup diagnoseEmbyLoginFailure makes on a
// failed login. Short and fixed: a slow/hanging Emby server must not make a
// failed login take noticeably longer than it does today, and this is never
// derived from the request.
const EMBY_LOGIN_DIAGNOSIS_TIMEOUT_MS = 3000;

// SECURITY (deliberate, owner-accepted trade-off): diagnoseEmbyLoginFailure
// below distinguishes "no such Emby user" from "wrong password" on this
// UNAUTHENTICATED endpoint, which is a user-enumeration oracle - an anonymous
// caller can learn whether a given username exists on the owner's Emby
// server (and, once it does, whether it's disabled/locked-out vs. just a bad
// password) that they could not learn before this endpoint existed. The
// owner explicitly asked for this (self-hosted, single-owner instance) to
// diagnose a stale-password autofill after changing their own Emby password.
// This rate limit is the mitigation: it bounds how fast the oracle can be
// queried in bulk. It is an explicit, fixed, server-side rule - never derived
// from the request - registered on the plugin itself (Better Auth's built-in
// /sign-in* rate limit, configured in auth.ts, does not match this path).
const EMBY_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60;
const EMBY_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;

type EmbyEndpointCtx = Parameters<typeof setSessionCookie>[0];

/** Create a Better Auth session for the user and set the cookie. */
async function createEmbySession(ctx: EmbyEndpointCtx, userId: string) {
  const session = await ctx.context.internalAdapter.createSession(userId);
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) throw new APIError('UNAUTHORIZED', { message: 'User not found' });
  await setSessionCookie(ctx, { session, user });
  return { session, user };
}

/**
 * Decide whether an authenticated Emby admin may log in as the owner, and
 * whether their Emby identity needs to be linked. Pure so it is unit-testable.
 *
 * - No existing Emby link on this account, owner has no Emby link yet  -> link (TOFU).
 * - Link exists and belongs to the owner                              -> allow.
 * - Link exists but belongs to someone else / owner bound elsewhere   -> deny.
 */
export function decideEmbyOwnerLogin(input: {
  isAdmin: boolean;
  ownerId: string;
  embyAccountId: string;
  /** auth_accounts row for (provider 'emby', accountId=embyAccountId), if any */
  linkForThisEmbyAccount: { userId: string } | null;
  /** does the owner already have ANY emby link bound? */
  ownerHasEmbyLink: boolean;
}): { allow: true; needsLink: boolean } | { allow: false; reason: string } {
  if (!input.isAdmin) {
    return { allow: false, reason: 'Only an Emby administrator can log in to Tracearr.' };
  }
  const link = input.linkForThisEmbyAccount;
  if (link) {
    if (link.userId === input.ownerId) return { allow: true, needsLink: false };
    return { allow: false, reason: 'This Emby account is not the Tracearr owner.' };
  }
  // No link for this Emby account yet.
  if (input.ownerHasEmbyLink) {
    // Owner is already bound to a different Emby identity — don't rebind.
    return { allow: false, reason: 'This Emby account is not the Tracearr owner.' };
  }
  return { allow: true, needsLink: true };
}

/** The owner's configured Emby server — the only server we trust to auth against. */
async function resolveConfiguredEmbyServer(): Promise<{ url: string; token: string } | null> {
  const [server] = await db
    .select({ url: servers.url, token: servers.token })
    .from(servers)
    .where(eq(servers.type, 'emby'))
    .limit(1);
  return server ? { url: server.url.replace(/\/$/, ''), token: server.token } : null;
}

/**
 * Best-effort reason for a failed Emby username/password login. Uses the
 * configured server's own admin API key (see EmbyClient.diagnoseLoginFailure)
 * to look up the account - NEVER the password the caller submitted, which is
 * not echoed anywhere in this path. Never throws and never takes noticeably
 * longer than the plain "invalid" case: any missing key, lookup failure, or
 * timeout falls back to today's undifferentiated message so the diagnosis
 * can only make a failed login MORE informative, never worse (slower,
 * different failure mode, etc).
 */
export async function diagnoseEmbyLoginFailure(
  server: { url: string; token: string },
  username: string
): Promise<{ code: EmbyLoginFailureReason; message: string }> {
  const fallback = {
    code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
    message: 'Invalid Emby username or password.',
  };
  if (!server.token) return fallback;

  let reason: EmbyLoginFailureReason;
  try {
    reason = await EmbyClient.diagnoseLoginFailure(
      server.url,
      server.token,
      username,
      EMBY_LOGIN_DIAGNOSIS_TIMEOUT_MS
    );
  } catch {
    return fallback;
  }

  switch (reason) {
    case EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND:
      return {
        code: reason,
        message: 'No Emby account exists with that username.',
      };
    case EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED:
      return {
        code: reason,
        message: 'This Emby account has been disabled by an administrator.',
      };
    case EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT:
      return {
        code: reason,
        message:
          'This Emby account is temporarily locked after too many failed sign-in attempts. Wait a few minutes and try again, or unlock it from the Emby dashboard.',
      };
    case EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD:
      return {
        code: reason,
        // Points at the scenario the owner actually hit: a browser autofilling
        // a password from before an Emby password change.
        message:
          'This Emby account exists, but the password was rejected. If you recently changed your Emby password, make sure your browser is not autofilling the old one.',
      };
    default:
      return fallback;
  }
}

export const embyPlugin = () =>
  ({
    id: 'emby',
    endpoints: {
      embyLogin: createAuthEndpoint(
        '/emby/login',
        { method: 'POST', body: loginBody },
        async (ctx) => {
          const { username, password } = ctx.body;

          const server = await resolveConfiguredEmbyServer();
          if (!server) {
            throw new APIError('BAD_REQUEST', {
              message: 'No Emby server is configured. Connect an Emby server first.',
            });
          }
          const { url } = server;

          let authResult;
          try {
            authResult = await EmbyClient.authenticate(url, username, password);
          } catch {
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: `Could not reach the Emby server at ${url}.`,
            });
          }
          if (!authResult) {
            const diagnosis = await diagnoseEmbyLoginFailure(server, username);
            throw new APIError('UNAUTHORIZED', {
              message: diagnosis.message,
              code: diagnosis.code,
            });
          }
          if (!authResult.isAdmin) {
            throw new APIError('FORBIDDEN', {
              message: 'Only an Emby administrator can log in to Tracearr.',
            });
          }

          const [owner] = await db.select().from(users).where(eq(users.role, 'owner')).limit(1);

          // No owner => fail closed. First-run owner creation is the local-signup
          // flow (an Emby login can't bootstrap an owner: doing so would let an
          // admin on ANY reachable Emby become the owner). Emby login only maps to
          // an already-established owner + configured server.
          if (!owner) {
            throw new APIError('FORBIDDEN', {
              message: 'Set up the owner account first, then link Emby.',
            });
          }

          // ---- Verify/bind this Emby identity to the owner. ----
          const [linkForThisEmbyAccount] = await db
            .select({ userId: authAccounts.userId })
            .from(authAccounts)
            .where(
              and(
                eq(authAccounts.providerId, EMBY_PROVIDER),
                eq(authAccounts.accountId, authResult.id)
              )
            )
            .limit(1);

          const [ownerEmbyLink] = await db
            .select({ id: authAccounts.id })
            .from(authAccounts)
            .where(
              and(eq(authAccounts.providerId, EMBY_PROVIDER), eq(authAccounts.userId, owner.id))
            )
            .limit(1);

          const decision = decideEmbyOwnerLogin({
            isAdmin: authResult.isAdmin,
            ownerId: owner.id,
            embyAccountId: authResult.id,
            linkForThisEmbyAccount: linkForThisEmbyAccount ?? null,
            ownerHasEmbyLink: Boolean(ownerEmbyLink),
          });
          if (!decision.allow) {
            throw new APIError('FORBIDDEN', { message: decision.reason });
          }

          if (decision.needsLink) {
            try {
              await db
                .insert(authAccounts)
                .values({
                  id: randomUUID(),
                  accountId: authResult.id,
                  providerId: EMBY_PROVIDER,
                  userId: owner.id,
                  accessToken: authResult.token,
                })
                .onConflictDoUpdate({
                  target: [authAccounts.providerId, authAccounts.accountId],
                  set: { userId: owner.id, accessToken: authResult.token, updatedAt: new Date() },
                });
            } catch (err) {
              // The `one Emby per user` partial unique index rejects a second,
              // different Emby account racing to bind the owner. The loser is
              // denied rather than silently sharing owner access.
              if (err instanceof Error && err.message.includes('auth_accounts_one_emby_per_user')) {
                throw new APIError('FORBIDDEN', {
                  message: 'This Emby account is not the Tracearr owner.',
                });
              }
              throw err;
            }
          } else {
            // Refresh the stored token on each successful login.
            await db
              .update(authAccounts)
              .set({ accessToken: authResult.token, updatedAt: new Date() })
              .where(
                and(
                  eq(authAccounts.providerId, EMBY_PROVIDER),
                  eq(authAccounts.accountId, authResult.id)
                )
              );
          }

          const { user: sessionUser } = await createEmbySession(ctx, owner.id);
          return ctx.json({
            authorized: true,
            user: { id: sessionUser.id, username: owner.username, role: 'owner' },
          });
        }
      ),
    },
    // See EMBY_LOGIN_RATE_LIMIT_* above for why this endpoint needs its own
    // rule: it doesn't match Better Auth's built-in /sign-in* special rule
    // (auth.ts), and the enumeration-oracle trade-off this endpoint makes
    // (diagnoseEmbyLoginFailure) needs its own bound on query volume.
    rateLimit: [
      {
        pathMatcher: (path: string) => path === '/emby/login',
        window: EMBY_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
        max: EMBY_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      },
    ],
  }) satisfies BetterAuthPlugin;
