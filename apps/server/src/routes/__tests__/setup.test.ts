/**
 * Setup routes unit tests
 *
 * Tests the API endpoint for checking Tracearr configuration status:
 * - GET /status - Check if setup is needed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

// Mock the claim code module
vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn().mockReturnValue(false), // Default to disabled
}));

// Import the mocked modules and the routes
import { db } from '../../db/client.js';
import { isClaimCodeEnabled } from '../../utils/claimCode.js';
import { setupRoutes } from '../setup.js';

/**
 * Helper to mock db.select with multiple chained calls
 * Setup route uses Promise.all with 4 parallel queries:
 * 1. All servers
 * 2. Jellyfin servers (where type = 'jellyfin')
 * 3. Owners (where role = 'owner')
 * 4. Password users (where passwordHash is not null)
 * Plus 1 settings query (localLoginEnabled), which falls through to its
 * default (true) when unmocked.
 */
function mockDbSelectMultiple(results: unknown[][]) {
  let callIndex = 0;
  const createChain = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      return Promise.resolve(results[callIndex++] || []);
    }),
  });

  vi.mocked(db.select).mockImplementation(() => createChain() as never);
}

/**
 * Build a test Fastify instance
 * Note: Setup routes are public (no auth required)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Register routes
  await app.register(setupRoutes, { prefix: '/setup' });

  return app;
}

describe('Setup Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset isClaimCodeEnabled to default (false)
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /setup/status', () => {
    it('returns needsSetup true when no owners exist', async () => {
      app = await buildTestApp();

      // Mock: servers exist, no jellyfin servers, no owners, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [], // jellyfin servers query
        [], // owners query (empty = needs setup)
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: true,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('returns requiresClaimCode true when claim code enabled and setup needed', async () => {
      app = await buildTestApp();

      // Enable claim code for this test
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);

      // Mock: no owners (needs setup)
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [], // jellyfin servers query
        [], // owners query (empty = needs setup)
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: true, // Claim code enabled and setup needed
        hasServers: true,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('returns needsSetup false when owner exists', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, owner exists, password user exists
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [{ id: 'user-1' }], // owners query (has owner)
        [{ id: 'user-1' }], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('returns hasServers false when no servers configured', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin servers, no owners, no password users
      mockDbSelectMultiple([
        [], // servers query (empty)
        [], // jellyfin servers query
        [], // owners query
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('returns hasPasswordAuth true when user has password set', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin servers, owner exists, password user exists
      mockDbSelectMultiple([
        [], // servers query
        [], // jellyfin servers query
        [{ id: 'user-1' }], // owners query
        [{ id: 'user-1' }], // password users query (has password)
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('returns hasPasswordAuth false when no users have passwords', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, owner exists, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [{ id: 'user-1' }], // owners query
        [], // password users query (empty)
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('handles fresh installation state correctly', async () => {
      app = await buildTestApp();

      // Mock: completely empty database
      mockDbSelectMultiple([
        [], // no servers
        [], // no jellyfin servers
        [], // no owners
        [], // no password users
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });

    it('handles fully configured state correctly', async () => {
      app = await buildTestApp();

      // Mock: fully configured installation
      mockDbSelectMultiple([
        [{ id: 'server-1' }, { id: 'server-2' }], // multiple servers
        [{ id: 'server-1' }], // jellyfin servers
        [{ id: 'owner-1' }], // owner exists
        [{ id: 'owner-1' }, { id: 'user-2' }], // multiple password users
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: false,
          emby: true,
          oidc: false,
          oidcProviderName: null,
        },
      });
    });
  });
});
