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
import { db } from '../db/client.js';
import { users, servers, authAccounts } from '../db/schema.js';
import { EmbyClient } from '../services/mediaServer/index.js';
import { assertSignupAllowed, assertClaimCode } from './authGuards.js';

const EMBY_PROVIDER = 'emby';

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string(),
  // Optional: defaults to the configured Emby server. Provided on first-run when
  // no server is registered yet.
  serverUrl: z.url().optional(),
  claimCode: z.string().optional(),
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

async function resolveEmbyServerUrl(provided: string | undefined): Promise<string | null> {
  if (provided) return provided.replace(/\/$/, '');
  const [server] = await db
    .select({ url: servers.url })
    .from(servers)
    .where(eq(servers.type, 'emby'))
    .limit(1);
  return server ? server.url.replace(/\/$/, '') : null;
}

export const embyPlugin = () =>
  ({
    id: 'emby',
    endpoints: {
      embyLogin: createAuthEndpoint(
        '/emby/login',
        { method: 'POST', body: loginBody },
        async (ctx) => {
          const { username, password, serverUrl, claimCode } = ctx.body;

          const url = await resolveEmbyServerUrl(serverUrl);
          if (!url) {
            throw new APIError('BAD_REQUEST', {
              message: 'No Emby server is configured. Provide the Emby server URL.',
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

          // ---- First-run: no owner yet. Create the owner from this Emby admin. ----
          if (!owner) {
            await assertSignupAllowed(); // fails closed if an owner somehow exists
            assertClaimCode(claimCode);

            const newUserId = randomUUID();
            const inserted = await db
              .insert(users)
              .values({
                id: newUserId,
                username: authResult.username.toLowerCase(),
                displayUsername: authResult.username,
                name: authResult.username,
                role: 'owner',
                emailVerified: true,
              })
              .returning();
            const created = inserted[0];
            if (!created) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user.' });
            }
            await db.insert(authAccounts).values({
              id: randomUUID(),
              accountId: authResult.id,
              providerId: EMBY_PROVIDER,
              userId: created.id,
              accessToken: authResult.token,
            });
            const { user: sessionUser } = await createEmbySession(ctx, created.id);
            return ctx.json({
              authorized: true,
              user: { id: sessionUser.id, username: created.username, role: 'owner' },
            });
          }

          // ---- Owner exists: verify/bind this Emby identity to the owner. ----
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
