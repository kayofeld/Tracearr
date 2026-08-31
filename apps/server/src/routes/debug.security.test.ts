/**
 * Debug Routes Security Tests
 *
 * Ensures debug routes are properly protected and only accessible by owners.
 * These routes can cause significant data loss, so security is critical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  generateTestToken,
  createOwnerPayload,
  createViewerPayload,
} from '../test/helpers.js';
import { debugRoutes } from './debug.js';

// Count queries are awaited straight off .from() or off a .where() after it,
// so the stub row set answers to both.
const { countRows } = vi.hoisted(() => {
  const rows: { count: number }[] = [{ count: 0 }];
  return { countRows: Object.assign(rows, { where: () => rows }) };
});

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(countRows),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
      returning: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [{ size: '10 MB' }] }),
  },
}));

vi.mock('../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sessions: { id: 'id' },
  users: { id: 'id' },
  servers: { id: 'id' },
  settings: { id: 'id' },
}));

vi.mock('../lib/auth.js', () => ({
  getAuth: vi.fn().mockReturnValue({
    $context: Promise.resolve({
      internalAdapter: { deleteSessions: vi.fn().mockResolvedValue(undefined) },
    }),
  }),
}));

vi.mock('./mobile.js', () => ({
  revokeMobileDeviceSession: vi.fn().mockResolvedValue(undefined),
}));

describe('Debug Routes Security', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();

    // Register debug routes
    await app.register(debugRoutes, { prefix: '/api/v1/debug' });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // All debug endpoints that need testing
  const debugEndpoints = [
    { method: 'GET', url: '/api/v1/debug/stats' },
    { method: 'DELETE', url: '/api/v1/debug/sessions' },
    { method: 'DELETE', url: '/api/v1/debug/violations' },
    { method: 'DELETE', url: '/api/v1/debug/users' },
    { method: 'DELETE', url: '/api/v1/debug/servers' },
    { method: 'DELETE', url: '/api/v1/debug/automations' },
    { method: 'POST', url: '/api/v1/debug/reset' },
    { method: 'POST', url: '/api/v1/debug/refresh-aggregates' },
    { method: 'GET', url: '/api/v1/debug/logs' },
    { method: 'GET', url: '/api/v1/debug/logs/tracearr.log' },
    { method: 'GET', url: '/api/v1/debug/env' },
  ];

  describe('Unauthenticated Access Prevention', () => {
    it.each(debugEndpoints)(
      'should reject unauthenticated requests to $method $url',
      async ({ method, url }) => {
        const res = await app.inject({ method: method as any, url });

        expect(res.statusCode).toBe(401);
        expect(res.json().message).toContain('Invalid or expired token');
      }
    );
  });

  describe('Guest User Access Prevention', () => {
    it.each(debugEndpoints)(
      'should reject guest users on $method $url',
      async ({ method, url }) => {
        const guestToken = generateTestToken(app, createViewerPayload());

        const res = await app.inject({
          method: method as any,
          url,
          headers: { Authorization: `Bearer ${guestToken}` },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().message).toContain('Owner access required');
      }
    );
  });

  describe('Owner Access Allowed', () => {
    it.each(debugEndpoints)(
      'should allow owner access to $method $url',
      async ({ method, url }) => {
        const ownerToken = generateTestToken(app, createOwnerPayload());

        const res = await app.inject({
          method: method as any,
          url,
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        // Owner should not get 401 or 403
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
        // Should get 200/404/500 (404 possible for non-supervised log endpoints)
        expect([200, 404, 500]).toContain(res.statusCode);
      }
    );
  });

  // Token edge cases (expired/tampered/invalid formats) are covered against
  // the REAL production decorators in auth.security.test.ts; this file's job
  // is proving the debug routes are actually wired to those decorators.
});

describe('Debug Routes - Destructive Operation Safeguards', () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.register(debugRoutes, { prefix: '/api/v1/debug' });
    await app.ready();

    ownerToken = generateTestToken(app, createOwnerPayload());
  });

  afterAll(async () => {
    await app.close();
  });

  it('should not expose database credentials in /env', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/debug/env',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const envString = JSON.stringify(body);

    // Should not contain actual secrets
    expect(envString).not.toContain('password');
    expect(envString).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/); // DB URL with password
    expect(envString).not.toMatch(/redis:\/\/:[^@]+@/); // Redis URL with password
  });

  it('should return structured stats without exposing internals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/debug/stats',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Should have expected structure
    expect(body).toHaveProperty('counts');
    expect(body).toHaveProperty('database');

    // Should not leak internal paths
    const bodyString = JSON.stringify(body);
    expect(bodyString).not.toContain('/Users/');
    expect(bodyString).not.toContain('node_modules');
  });
});
