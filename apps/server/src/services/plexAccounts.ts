/**
 * Reconciling a linked Plex account's token across the rows that cache it.
 *
 * plex.tv owns the fact "this account owns this machine identifier".
 * `servers.plex_account_id` and `servers.token` are caches of that fact, and a
 * revoked token is precisely the case where neither cache can be trusted nor
 * repaired from what is already stored: the auto-repair in GET /plex/accounts
 * identifies a server by calling plex.tv with the server's own stored token.
 * So this reconciles against plex.tv and treats the stored link as a fallback.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ReauthorizedServerStatus } from '@tracearr/shared';
import { db } from '../db/client.js';
import { plexAccounts, servers } from '../db/schema.js';
import { invalidateServersCache } from '../jobs/poller/database.js';
import { upsertPlexAuthAccount } from '../lib/plexPlugin.js';
import { PlexClient } from './mediaServer/index.js';
import { ensureServerIdentifier } from './serverIdentity.js';

export interface ReconciledServer {
  id: string;
  name: string;
  url: string;
  status: ReauthorizedServerStatus;
}

export interface PlexTokenReconcileResult {
  reconciled: ReconciledServer[];
  /** Plex servers left with no account link, so still holding a dead token */
  unmatched: { id: string; name: string }[];
}

export type PlexAuthResult = NonNullable<Awaited<ReturnType<typeof PlexClient.checkOAuthPin>>>;

interface Logger {
  debug: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

/** Callers must have already proven `auth` belongs to `account`; this writes unconditionally. */
export async function reconcilePlexAccountToken(
  account: typeof plexAccounts.$inferSelect,
  auth: PlexAuthResult,
  log?: Logger
): Promise<PlexTokenReconcileResult> {
  let ownedIdentifiers: string[] = [];
  try {
    const owned = await PlexClient.getServers(auth.token);
    ownedIdentifiers = owned.map((s) => s.clientIdentifier).filter(Boolean);
  } catch (error) {
    log?.warn(
      { err: error, accountId: account.id },
      'Could not list owned servers from plex.tv, reconciling against the stored links only'
    );
  }

  // Matching needs an identifier and servers added by hand never got one.
  // /identity answers 200 with no token and with a garbage one (checked against
  // PMS 1.43.3, where /library/sections and /accounts both 401), so it fills in
  // behind a revoked token. What stays null is reported unmatched below.
  if (ownedIdentifiers.length > 0) {
    const unidentified = await db
      .select({
        id: servers.id,
        type: servers.type,
        url: servers.url,
        token: servers.token,
        machineIdentifier: servers.machineIdentifier,
      })
      .from(servers)
      .where(
        and(
          eq(servers.type, 'plex'),
          isNull(servers.plexAccountId),
          isNull(servers.machineIdentifier)
        )
      );

    for (const server of unidentified) {
      await ensureServerIdentifier(server, log);
    }
  }

  const reconciledAt = new Date();
  const reconciled = await db.transaction(async (tx) => {
    await tx
      .update(plexAccounts)
      .set({
        plexToken: auth.token,
        plexUsername: auth.username,
        plexEmail: auth.email,
        plexThumbnail: auth.thumb,
      })
      .where(eq(plexAccounts.id, account.id));

    // Read the prior link before overwriting it: RETURNING would report the new
    // value, which cannot distinguish an adoption from a plain refresh.
    const targets = await tx
      .select({
        id: servers.id,
        name: servers.name,
        url: servers.url,
        plexAccountId: servers.plexAccountId,
      })
      .from(servers)
      .where(
        and(
          eq(servers.type, 'plex'),
          ownedIdentifiers.length > 0
            ? or(
                eq(servers.plexAccountId, account.id),
                inArray(servers.machineIdentifier, ownedIdentifiers)
              )
            : eq(servers.plexAccountId, account.id)
        )
      );

    if (targets.length > 0) {
      await tx
        .update(servers)
        .set({ token: auth.token, plexAccountId: account.id, updatedAt: reconciledAt })
        .where(
          inArray(
            servers.id,
            targets.map((s) => s.id)
          )
        );
    }

    // auth_accounts holds a third copy of this token, so a failure here has to
    // roll the other two back rather than leave them disagreeing.
    await upsertPlexAuthAccount(account.userId, account.plexAccountId, auth, tx);

    return targets.map((s): ReconciledServer => ({
      id: s.id,
      name: s.name,
      url: s.url,
      status: s.plexAccountId === account.id ? 'refreshed' : 'adopted',
    }));
  });

  invalidateServersCache();

  const unmatched = await db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(and(eq(servers.type, 'plex'), isNull(servers.plexAccountId)));

  return { reconciled, unmatched };
}
