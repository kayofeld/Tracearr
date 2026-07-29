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
import { db } from '../db/client.js';
import { users, servers, authAccounts } from '../db/schema.js';
import { EmbyClient } from '../services/mediaServer/index.js';
import {
  isUniqueViolationOn,
  AUTH_ACCOUNTS_ONE_EMBY_PER_USER_CONSTRAINT,
} from '../utils/dbErrors.js';

const EMBY_PROVIDER = 'emby';

// NOTE: the server URL is NEVER taken from the client for an EXISTING owner's
// login. It is resolved from the owner's own configured Emby server. Accepting
// a client URL here would let an attacker point login at their OWN Emby
// (where they are trivially admin), satisfy the isAdmin gate, and get bound
// as the Tracearr owner (auth bypass), as well as drive SSRF. Only credentials
// are accepted here. A client-supplied URL is accepted by exactly one
// endpoint instance-wide, POST /emby/setup (embySetupPlugin.ts), and only
// while the instance is unclaimed - see docs/architecture/emby-native-setup.md
// §2 and §3.
const loginBody = z.object({
  username: z.string().min(1),
  password: z.string(),
});

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
} | null> {
  const rows = await db
    .select({ id: servers.id, name: servers.name, url: servers.url })
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

export const embyPlugin = () =>
  ({
    id: 'emby',
    endpoints: {
      embyLogin: createAuthEndpoint(
        '/emby/login',
        { method: 'POST', body: loginBody },
        async (ctx) => {
          const { username, password } = ctx.body;

          let url: string | null;
          try {
            url = await resolveConfiguredEmbyServerUrl();
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
          if (!url) {
            throw new APIError('BAD_REQUEST', {
              message: 'No Emby server is configured. Connect an Emby server first.',
            });
          }

          let authResult;
          try {
            authResult = await EmbyClient.authenticate(url, username, password);
          } catch {
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: `Could not reach the Emby server at ${url}.`,
            });
          }
          if (!authResult) {
            throw new APIError('UNAUTHORIZED', { message: 'Invalid Emby username or password.' });
          }
          if (!authResult.isAdmin) {
            throw new APIError('FORBIDDEN', {
              message: 'Only an Emby administrator can log in to Tracearr.',
            });
          }

          const [owner] = await db.select().from(users).where(eq(users.role, 'owner')).limit(1);

          // No owner => fail closed. First-run owner creation is POST /emby/setup
          // (embySetupPlugin.ts) or the local-signup flow - never this endpoint
          // (an Emby login can't bootstrap an owner: doing so would let an admin
          // on ANY reachable Emby become the owner). Emby login only maps to an
          // already-established owner + configured server.
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
              // denied rather than silently sharing owner access. (CR-2 fix:
              // drizzle wraps the driver error in DrizzleQueryError, whose own
              // .message never names the constraint - see dbErrors.ts.)
              if (isUniqueViolationOn(err, AUTH_ACCOUNTS_ONE_EMBY_PER_USER_CONSTRAINT)) {
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
  }) satisfies BetterAuthPlugin;
