/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { isNotNull, eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, users, authAccounts } from '../db/schema.js';
import { isClaimCodeEnabled } from '../utils/claimCode.js';
import { getSetting } from '../services/settings.js';
import { oidcConfigured } from '../lib/auth.js';
import { EMBY_PROVIDER } from '../lib/embyPlugin.js';

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check Tracearr configuration status
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   *
   * Returns:
   * - needsSetup: true if no owner accounts exist
   * - requiresClaimCode: true if first-time setup requires a claim code
   * - hasServers: true if at least one server is configured
   * - hasPasswordAuth: true if at least one user has password login enabled
   */
  app.get('/status', async () => {
    // Check for servers and users in parallel
    const [
      serverList,
      jellyfinServerList,
      ownerList,
      passwordUserList,
      ownerEmbyLinkList,
      embyServerList,
    ] = await Promise.all([
      db.select({ id: servers.id }).from(servers).limit(1),
      db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'jellyfin')).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
      db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
      // Owner has a bound Emby identity - joined (not a two-step lookup off
      // ownerList above) so this stays independent in the same Promise.all.
      db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .innerJoin(users, eq(authAccounts.userId, users.id))
        .where(and(eq(authAccounts.providerId, EMBY_PROVIDER), eq(users.role, 'owner')))
        .limit(1),
      // M1 (code review): a configured Emby-type server must still exist for
      // embyAccountLinked to be true - mirrors hasJellyfinServers above.
      // Otherwise deleting the Emby server while the auth_accounts link row
      // survives would leave the login page leading with an Emby-only form
      // whose every submit fails "No Emby server is configured".
      db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'emby')).limit(1),
    ]);

    const localLoginEnabled = await getSetting('localLoginEnabled');

    const needsSetup = ownerList.length === 0;

    return {
      needsSetup,
      requiresClaimCode: needsSetup && isClaimCodeEnabled(), // Claim code required only if enabled and setup needed
      hasServers: serverList.length > 0,
      hasJellyfinServers: jellyfinServerList.length > 0,
      hasPasswordAuth: passwordUserList.length > 0,
      authMethods: {
        local: localLoginEnabled,
        // Plex login was replaced by Emby credential login (embyPlugin).
        plex: false,
        emby: true,
        oidc: oidcConfigured,
        oidcProviderName: oidcConfigured ? (process.env.OIDC_PROVIDER_NAME ?? 'SSO') : null,
      },
      // Presentation signal only - local login (authMethods.local) stays
      // enabled regardless; see SetupStatus.embyAccountLinked in
      // @tracearr/shared for why. Requires BOTH the owner's link row AND a
      // still-configured Emby server (M1, code review).
      embyAccountLinked: ownerEmbyLinkList.length > 0 && embyServerList.length > 0,
    };
  });
};
