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
import { eq, and, asc } from 'drizzle-orm';
import {
  EMBY_LOGIN_FAILURE_REASONS,
  EMBY_LOGIN_PATH,
  type EmbyLoginFailureReason,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, servers, authAccounts, serverUsers } from '../db/schema.js';
import { EmbyClient } from '../services/mediaServer/index.js';

/** Minimal logger shape accepted by diagnoseEmbyLoginFailure (matches Better
 * Auth's ctx.context.logger and the repo's own Logger interface) - kept
 * structural so tests can pass a bare `{ warn: vi.fn() }`. */
interface DiagnosisLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

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
// failed login whose username matches the linked account (see F5: this DOES
// add latency to that case - a slow/hanging Emby server can delay the
// response by up to this many ms - so it is short and fixed, and never
// derived from the request, to cap the worst case rather than pretend there
// is none).
const EMBY_LOGIN_DIAGNOSIS_TIMEOUT_MS = 3000;

// SECURITY (owner-accepted, narrowed after security review): an earlier
// version of diagnoseEmbyLoginFailure below matched the submitted username
// against every account on the owner's Emby server (`/Users`), which was a
// user-enumeration oracle covering every Emby account, not only the owner's
// - flagged as F1 (High) in the security review. It is now scoped to ONLY
// the single Emby account already linked to the Tracearr owner in
// auth_accounts, resolved by its stored account id - never a name search.
// A caller who does not already know the owner's own linked Emby username
// (or submits any other username) gets the pre-existing generic message
// with no diagnosis and no outbound call to Emby at all. `account_locked_out`
// is never reported (F2, High): this endpoint forwards real credentials to
// the owner's own Emby server, so reporting a lockout would confirm to an
// attacker that their credential-stuffing tripped Emby's own lockout - a
// locked-out account now falls back to `wrong_password`.
// This rate limit remains the mitigation for the residual signal (whether
// the owner's OWN account is disabled vs. simply rejected the password): it
// bounds how fast that can be queried. It is an explicit, fixed, server-side
// rule - never derived from the request - registered on the plugin itself
// (Better Auth's built-in /sign-in* rate limit, configured in auth.ts, does
// not match this path). See security review F3/F4 for the two conditions
// this rule depends on: the resolved client IP must reflect only the real
// proxy hop (trustProxy.ts), and this path must be a single frozen constant
// shared with the pathMatcher below (EMBY_LOGIN_PATH), never a second
// hand-typed literal.
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

/**
 * Thrown by resolveConfiguredEmbyServerUrl() when more than one `emby` row
 * exists, so the caller can distinguish "ambiguous" from "not configured"
 * (SEC-02 fix, design §4.1). The `servers_single_emby` partial unique index
 * (migration 0070) makes a second row impossible to insert, so this is
 * defense in depth for an instance that already held two rows before the
 * index existed, not the primary control.
 */
export class AmbiguousEmbyServerError extends Error {
  constructor() {
    super('More than one Emby server is configured; Emby login is unavailable until resolved.');
    this.name = 'AmbiguousEmbyServerError';
  }
}

/**
 * The owner's configured Emby server row — the only server we trust to auth
 * against. Deterministic: orders by (createdAt, id) and inspects up to 2 rows
 * so it can distinguish "none" from "ambiguous" rather than picking an
 * arbitrary one of several rows (SEC-02 fix, design §4.1). Two rows means two
 * authentication authorities and, combined with an ownerless instance, is
 * exactly the bypass the NOTE above exists to prevent - so ambiguity must
 * fail closed, never silently resolve to whichever row Postgres happens to
 * return first. Exported (not just the URL-only wrapper below) so the
 * ambiguity-detection behavior itself is directly unit-testable
 * (embyPlugin.test.ts) without going through /emby/login. There is no
 * network path that adopts/updates this row - an `ownerless-with-data`
 * instance refuses every claim attempt unconditionally (CR-3/IMP-01,
 * embySetupPlugin.ts) and recovers only via the console CLI.
 */
export async function resolveConfiguredEmbyServerRow(): Promise<{
  id: string;
  name: string;
  url: string;
  token: string;
} | null> {
  const rows = await db
    .select({ id: servers.id, name: servers.name, url: servers.url, token: servers.token })
    .from(servers)
    .where(eq(servers.type, 'emby'))
    .orderBy(asc(servers.createdAt), asc(servers.id))
    .limit(2);

  if (rows.length > 1) {
    throw new AmbiguousEmbyServerError();
  }
  const server = rows[0];
  return server ? { ...server, url: server.url.replace(/\/$/, '') } : null;
}

/** URL-only convenience wrapper over resolveConfiguredEmbyServerRow(), used by /emby/login. */
export async function resolveConfiguredEmbyServerUrl(): Promise<string | null> {
  const row = await resolveConfiguredEmbyServerRow();
  return row ? row.url : null;
}

/**
 * Best-effort reason for a failed Emby username/password login, scoped ONLY
 * to the Emby account already linked to the Tracearr owner (owner decision,
 * security review F1) - resolved entirely from LOCAL data before any call to
 * Emby is made:
 *
 * 1. Look up the owner's linked Emby account id in auth_accounts. No link at
 *    all -> generic message, no outbound call.
 * 2. Compare the submitted username against the username LOCALLY cached for
 *    that account id in server_users (populated by the existing Emby sync -
 *    see sync.ts / embyRoutes.ts). No cached row, or a mismatch -> generic
 *    message, no outbound call. This is what makes the endpoint safe against
 *    enumeration: a caller who does not already know the owner's own linked
 *    Emby username can never get anything beyond the pre-existing generic
 *    message, regardless of what they submit.
 * 3. Only once the username corresponds to the linked account does this make
 *    the single bounded outbound call (EmbyClient.getLinkedEmbyAccount, by
 *    account id - never a name search or a list scan) needed to read the
 *    account's LIVE disabled state, which the sync cache must never be
 *    trusted for.
 *
 * Never echoes the password the caller submitted, which does not reach this
 * function at all. This makes a failed login MORE informative when it can
 * determine a specific reason, but it is not free: every login whose
 * username matches the linked account now costs one extra request to the
 * Emby server (bounded by EMBY_LOGIN_DIAGNOSIS_TIMEOUT_MS), and a hanging
 * Emby server delays the response by up to that timeout. Any missing key,
 * lookup failure, or timeout falls back to the plain "invalid" message
 * rather than throwing; a caught failure is logged (message only, never
 * credentials or the server URL) so a persistently broken diagnosis (e.g. a
 * rotated admin key) is visible instead of silently degrading forever.
 */
export async function diagnoseEmbyLoginFailure(
  server: { id: string; url: string; token: string },
  username: string,
  logger?: DiagnosisLogger
): Promise<{ code: EmbyLoginFailureReason; message: string }> {
  const fallback = {
    code: EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS,
    message: 'Invalid Emby username or password.',
  };
  if (!server.token) return fallback;

  const [ownerEmbyLink] = await db
    .select({ accountId: authAccounts.accountId })
    .from(authAccounts)
    .innerJoin(users, eq(authAccounts.userId, users.id))
    .where(and(eq(authAccounts.providerId, EMBY_PROVIDER), eq(users.role, 'owner')))
    .limit(1);
  if (!ownerEmbyLink) return fallback;

  const [cachedAccount] = await db
    .select({ username: serverUsers.username })
    .from(serverUsers)
    .where(
      and(eq(serverUsers.serverId, server.id), eq(serverUsers.externalId, ownerEmbyLink.accountId))
    )
    .limit(1);
  if (cachedAccount?.username.toLowerCase() !== username.toLowerCase()) {
    return fallback;
  }

  let account: { isDisabled: boolean };
  try {
    account = await EmbyClient.getLinkedEmbyAccount(
      server.url,
      server.token,
      ownerEmbyLink.accountId,
      EMBY_LOGIN_DIAGNOSIS_TIMEOUT_MS
    );
  } catch (err) {
    logger?.warn('Emby login diagnosis lookup failed; falling back to generic message', { err });
    return fallback;
  }

  if (account.isDisabled) {
    return {
      code: EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED,
      message: 'This Emby account has been disabled by an administrator.',
    };
  }

  return {
    code: EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD,
    // Points at the scenario the owner actually hit: a browser autofilling
    // a password from before an Emby password change.
    message:
      'This Emby account exists, but the password was rejected. If you recently changed your Emby password, make sure your browser is not autofilling the old one.',
  };
}

export const embyPlugin = () =>
  ({
    id: 'emby',
    endpoints: {
      embyLogin: createAuthEndpoint(
        EMBY_LOGIN_PATH,
        { method: 'POST', body: loginBody },
        async (ctx) => {
          const { username, password } = ctx.body;

          // resolveConfiguredEmbyServerRow throws when more than one `emby`
          // row exists (SEC-02): two rows are two authentication authorities,
          // and silently picking whichever Postgres returned first is the
          // bypass the NOTE at the top of this file exists to prevent. Fail
          // closed with a distinct status rather than letting it escape as a
          // 500.
          let server: Awaited<ReturnType<typeof resolveConfiguredEmbyServerRow>>;
          try {
            server = await resolveConfiguredEmbyServerRow();
          } catch (err) {
            if (err instanceof AmbiguousEmbyServerError) {
              ctx.context.logger.error(
                'Emby login is unavailable: more than one Emby server is configured'
              );
              throw new APIError('SERVICE_UNAVAILABLE', {
                message: 'Emby login is unavailable: more than one Emby server is configured.',
              });
            }
            throw err;
          }
          if (!server) {
            throw new APIError('BAD_REQUEST', {
              message: 'No Emby server is configured. Connect an Emby server first.',
            });
          }
          const { url } = server;

          let authResult;
          try {
            authResult = await EmbyClient.authenticate(url, username, password);
          } catch (err) {
            // Anonymous caller - never disclose the configured Emby host/port
            // (security review F7). Logged server-side (URL only, never
            // credentials) so the owner can still diagnose connectivity.
            ctx.context.logger.warn('Could not reach configured Emby server for login', {
              err,
              url,
            });
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: 'Could not reach the Emby server. Try again shortly.',
            });
          }
          if (!authResult) {
            const diagnosis = await diagnoseEmbyLoginFailure(server, username, ctx.context.logger);
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
    // (auth.ts), and the residual diagnosis signal (diagnoseEmbyLoginFailure)
    // needs its own bound on query volume. pathMatcher compares against the
    // SAME EMBY_LOGIN_PATH constant the endpoint above is registered at
    // (security review F4) - a second hand-typed literal here would silently
    // unbind this rule from the real path on any rename, with no error.
    rateLimit: [
      {
        pathMatcher: (path: string) => path === EMBY_LOGIN_PATH,
        window: EMBY_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
        max: EMBY_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      },
    ],
  }) satisfies BetterAuthPlugin;
