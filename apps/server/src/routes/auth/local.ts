/**
 * Local Authentication Routes
 *
 * POST /signup - Create a local account
 * POST /login - Login with local credentials or initiate Plex OAuth
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateTokens } from './utils.js';
import { getUserByEmail, getOwnerUser } from '../../services/userService.js';
import { validateClaimCode, isClaimCodeEnabled } from '../../utils/claimCode.js';

// Schemas
const signupSchema = z.object({
  username: z.string().min(3).max(50), // Display name
  email: z.email(),
  password: z.string().min(8).max(100),
  claimCode: z.string().optional(), // Optional claim code for first-time setup
});

// Plex login now lives in the Better Auth plugin at /auth/plex/initiate.
// Note: Jellyfin login is handled at /auth/jellyfin/login, not here
const loginSchema = z.object({
  type: z.literal('local'),
  email: z.email(),
  password: z.string().min(1),
});

export const localRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /validate-claim-code - Validate claim code (stateless check)
   *
   * Validates the claim code without storing session.
   * Client uses this for immediate feedback.
   * Server will validate again during signup for security.
   */
  app.post('/validate-claim-code', async (request, reply) => {
    const body = z.object({ claimCode: z.string().min(1) }).safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Claim code is required');
    }

    const { claimCode } = body.data;

    if (!isClaimCodeEnabled()) {
      return reply.badRequest('Claim code validation not required');
    }

    if (!validateClaimCode(claimCode)) {
      return reply.forbidden('Invalid claim code');
    }

    return { success: true };
  });

  /**
   * POST /signup - Create a local account
   */
  app.post('/signup', async (request, reply) => {
    const body = signupSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(
        'Invalid signup data: email, username (3-50 chars), password (8+ chars) required'
      );
    }

    const { username, password, claimCode } = body.data;
    const email = body.data.email.toLowerCase();

    // Check if email already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return reply.conflict('Email already registered');
    }

    // Only the first user can sign up
    const owner = await getOwnerUser();
    if (owner) {
      return reply.forbidden(
        'This Tracearr instance already has an owner. Only the owner can log in.'
      );
    }

    // First user setup - validate claim code if enabled
    if (isClaimCodeEnabled()) {
      if (!claimCode) {
        return reply.forbidden('Claim code is required for first-time setup');
      }
      if (!validateClaimCode(claimCode)) {
        return reply.forbidden('Invalid claim code');
      }
      app.log.info('First-time setup with valid claim code');
    }

    const passwordHashValue = await hashPassword(password);
    const role = 'owner';

    const [newUser] = await db
      .insert(users)
      .values({
        username,
        email,
        passwordHash: passwordHashValue,
        role,
      })
      .returning();

    if (!newUser) {
      return reply.internalServerError('Failed to create user');
    }

    app.log.info({ userId: newUser.id, role }, 'Local account created');

    return generateTokens(app, newUser.id, newUser.username, newUser.role);
  });

  /**
   * POST /login - Login with local credentials or initiate Plex OAuth
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid login request');
    }

    const { password } = body.data;
    const email = body.data.email.toLowerCase();

    // Find user by email with password hash
    const userRows = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
      .limit(1);

    const user = userRows[0];
    if (!user?.passwordHash) {
      return reply.unauthorized('Invalid email or password');
    }

    // Verify password
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return reply.unauthorized('Invalid email or password');
    }

    app.log.info({ userId: user.id }, 'Local login successful');

    return generateTokens(app, user.id, user.username, user.role);
  });
};
