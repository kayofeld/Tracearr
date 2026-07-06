/**
 * Better Auth Backfill Migration Integration Tests
 *
 * Verifies the custom backfill migration (0061_better_auth_backfill.sql) against
 * a real database: email verification backfill, username normalization, and
 * credential/plex auth_accounts creation. Re-applies the SQL twice to confirm
 * idempotency (safe re-run on redeploy).
 *
 * Run with: pnpm test:integration
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'fs';
import { db } from '../client.js';
import { users, plexAccounts, authAccounts } from '../schema.js';
import { resetTestDb } from '@tracearr/test-utils/db';
import { createTestUser } from '@tracearr/test-utils/factories';

function backfillSql(): string {
  const migrationsDir = `${import.meta.dirname}/../migrations`;
  const file = readdirSync(migrationsDir).find((name) =>
    name.endsWith('_better_auth_backfill.sql')
  );
  if (!file) {
    throw new Error('better_auth_backfill migration file not found');
  }
  return readFileSync(`${migrationsDir}/${file}`, 'utf8');
}

describe('better auth backfill migration', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it('creates credential and plex account rows and is idempotent', async () => {
    const owner = await createTestUser({
      role: 'owner',
      username: 'Connor',
      email: 'owner@example.com',
      passwordHash: '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpQ0T1sSNIX9JBoHrGKl0eDX/2u6y',
    });
    await db.insert(plexAccounts).values({
      userId: owner.id,
      plexAccountId: 'plex-123',
      plexUsername: 'connor',
      plexEmail: 'owner@example.com',
      plexThumbnail: null,
      plexToken: 'tok-abc',
      allowLogin: true,
    });

    await db.execute(sql.raw(backfillSql()));
    await db.execute(sql.raw(backfillSql()));

    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(2);
    const credential = accounts.find((a) => a.providerId === 'credential');
    expect(credential?.userId).toBe(owner.id);
    expect(credential?.password).toMatch(/^\$2[aby]\$12\$/);
    const plex = accounts.find((a) => a.providerId === 'plex');
    expect(plex?.accountId).toBe('plex-123');
    expect(plex?.accessToken).toBe('tok-abc');

    const [row] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(row?.emailVerified).toBe(true);
    expect(row?.username).toBe('connor');
    expect(row?.displayUsername).toBe('Connor');
  });

  it('skips credential rows for empty-string password hashes', async () => {
    await createTestUser({
      role: 'viewer',
      username: 'emptyhash',
      email: 'emptyhash@example.com',
      passwordHash: '',
    });

    await db.execute(sql.raw(backfillSql()));

    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(0);
  });
});
