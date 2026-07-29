/**
 * Emby auth routes tests
 *
 * Tests POST /emby/connect-api-key, in particular IMP-05's fix for the
 * check-then-act race against the `servers_single_emby` partial unique
 * index (the single-Emby product rule, owner decision 3): two concurrent
 * connect requests can both see zero existing rows and both attempt an
 * insert; the race loser must get a clean 409, not a raw 500.
 */

import { describe, it, expect, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  EmbyClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      INVALID_KEY: 'INVALID_KEY',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
}));

vi.mock('../../../services/sync.js', () => ({ syncServer: vi.fn() }));

vi.mock('../utils.js', () => ({
  generateTokens: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
}));

import { db } from '../../../db/client.js';
import { EmbyClient } from '../../../services/mediaServer/index.js';
import { embyRoutes } from '../emby.js';

function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockDbInsertRejecting(err: Error) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockRejectedValue(err),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

/**
 * The REAL shape drizzle-orm 0.45's node-postgres driver produces for a
 * unique_violation (see utils/dbErrors.ts) - `DrizzleQueryError`'s own
 * `.message` never contains the constraint name; it lives on `.cause`.
 */
function makeWrappedUniqueViolation(constraint: string): DrizzleQueryError {
  const cause = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  ) as Error & { code: string; constraint: string };
  cause.code = '23505';
  cause.constraint = constraint;
  return new DrizzleQueryError('insert into "servers" ...', [], cause);
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });
  await app.register(embyRoutes);
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
};

describe('POST /emby/connect-api-key', () => {
  it('IMP-05: maps a servers_single_emby race loss to 409, not a raw 500', async () => {
    vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({ success: true });
    mockDbSelectLimit([]); // no existing row seen by this request
    mockDbInsertRejecting(makeWrappedUniqueViolation('servers_single_emby'));

    const app = await buildTestApp(ownerUser);
    const response = await app.inject({
      method: 'POST',
      url: '/emby/connect-api-key',
      payload: {
        serverUrl: 'http://emby.local:8096',
        serverName: 'Second Emby',
        apiKey: 'admin-key',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining('already configured'),
    });

    await app.close();
  });

  it('still surfaces a genuine, unrelated DB error as 500 (unchanged behavior)', async () => {
    vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({ success: true });
    mockDbSelectLimit([]);
    mockDbInsertRejecting(new Error('connection reset'));

    const app = await buildTestApp(ownerUser);
    const response = await app.inject({
      method: 'POST',
      url: '/emby/connect-api-key',
      payload: {
        serverUrl: 'http://emby.local:8096',
        serverName: 'Second Emby',
        apiKey: 'admin-key',
      },
    });

    expect(response.statusCode).toBe(500);

    await app.close();
  });
});
