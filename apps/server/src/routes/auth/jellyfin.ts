/**
 * Jellyfin Authentication Routes
 *
 * POST /jellyfin/login - Login with Jellyfin username/password (checks all configured servers)
 * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { JellyfinClient } from '../../services/mediaServer/index.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { generateTokens } from './utils.js';
import { syncServer } from '../../services/sync.js';
import { getUserByUsername } from '../../services/userService.js';

// Schema for Jellyfin login
const jellyfinLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Schema for API key connection
const jellyfinConnectApiKeySchema = z.object({
  serverUrl: z.url(),
  serverName: z.string().min(1).max(100),
  apiKey: z.string().min(1),
});

export const jellyfinRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /jellyfin/login - Login with Jellyfin username/password
   *
   * Checks all configured Jellyfin servers and authenticates if user is admin on any server.
   * Creates a new user with 'admin' role if user doesn't exist.
   */
  app.post('/jellyfin/login', async (request, reply) => {
    const body = jellyfinLoginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Username and password are required');
    }

    const { username, password } = body.data;

    try {
      // Get all configured Jellyfin servers
      const jellyfinServers = await db.select().from(servers).where(eq(servers.type, 'jellyfin'));

      if (jellyfinServers.length === 0) {
        return await reply.unauthorized(
          'No Jellyfin servers configured. Please add a server first.'
        );
      }

      // Try to authenticate with each server
      for (const server of jellyfinServers) {
        try {
          const authResult = await JellyfinClient.authenticate(server.url, username, password);

          if (authResult?.isAdmin) {
            // User is admin on this server - proceed with login
            app.log.info(
              { username, serverId: server.id },
              'Jellyfin admin authentication successful'
            );

            // Check if user already exists
            const user = await getUserByUsername(username);

            if (!user) {
              // Only the owner (created via Plex or local signup) can log in
              return await reply.forbidden(
                'This Tracearr instance already has an owner. Only the owner can log in.'
              );
            }

            if (user.role !== 'owner') {
              return await reply.forbidden('Only the owner can log in to this Tracearr instance.');
            }

            // Generate and return tokens
            return await generateTokens(app, user.id, user.username, user.role);
          }
        } catch (error) {
          // Authentication failed on this server, try next one
          app.log.debug(
            { error, serverId: server.id, username },
            'Jellyfin authentication failed on server'
          );
          continue;
        }
      }

      // Authentication failed on all servers or user is not admin
      app.log.warn({ username }, 'Jellyfin login failed: invalid credentials or not admin');
      return await reply.unauthorized(
        'Invalid username or password, or user is not an administrator on any configured Jellyfin server'
      );
    } catch (error) {
      app.log.error({ err: error, username }, 'Jellyfin login error');
      return await reply.internalServerError('Failed to authenticate with Jellyfin servers');
    }
  });

  /**
   * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
   */
  app.post(
    '/jellyfin/connect-api-key',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = jellyfinConnectApiKeySchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('serverUrl, serverName, and apiKey are required');
      }

      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only owners can add servers');
      }

      const { serverUrl, serverName, apiKey } = body.data;

      try {
        // Verify the API key has admin access
        const adminCheck = await JellyfinClient.verifyServerAdmin(apiKey, serverUrl);

        if (!adminCheck.success) {
          // Provide specific error based on failure type
          if (adminCheck.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED) {
            return reply.serviceUnavailable(adminCheck.message);
          }
          if (adminCheck.code === JellyfinClient.AdminVerifyError.INVALID_KEY) {
            return reply.unauthorized(adminCheck.message);
          }
          return reply.forbidden(adminCheck.message);
        }

        // Create or update server
        let server = await db
          .select()
          .from(servers)
          .where(and(eq(servers.url, serverUrl), eq(servers.type, 'jellyfin')))
          .limit(1);

        if (server.length === 0) {
          const inserted = await db
            .insert(servers)
            .values({
              name: serverName,
              type: 'jellyfin',
              url: serverUrl,
              token: apiKey,
            })
            .returning();
          server = inserted;
        } else {
          const existingServer = server[0]!;
          await db
            .update(servers)
            .set({
              name: serverName,
              token: apiKey,
              updatedAt: new Date(),
            })
            .where(eq(servers.id, existingServer.id));
        }

        const serverId = server[0]!.id;

        app.log.info(
          { userId: authUser.userId, serverId },
          'Jellyfin server connected via API key'
        );

        // Auto-sync server users and libraries in background
        syncServer(serverId, { syncUsers: true, syncLibraries: true })
          .then((result) => {
            app.log.info(
              { serverId, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced },
              'Auto-sync completed for Jellyfin server'
            );
          })
          .catch((error) => {
            app.log.error({ err: error, serverId }, 'Auto-sync failed for Jellyfin server');
          });

        // Return updated tokens with new server access
        return generateTokens(app, authUser.userId, authUser.username, authUser.role);
      } catch (error) {
        app.log.error({ err: error }, 'Jellyfin connect-api-key failed');
        return reply.internalServerError('Failed to connect Jellyfin server');
      }
    }
  );
};
