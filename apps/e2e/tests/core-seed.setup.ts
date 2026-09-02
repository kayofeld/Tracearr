import { test as setup } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from '../seed/env';
import { seedCore } from '../seed/seedCore';

/**
 * Bulk fixture seed (servers, libraries, titles, a member user) - runs as a
 * project that depends on auth.setup.ts rather than in Playwright's
 * globalSetup, so the owner account exists before any other row does.
 *
 * Fork note: first-run sign-up is refused on an instance that already holds
 * data but has no owner (authGuards OWNERLESS_INSTANCE_WITH_DATA - a lost
 * owner row must not be claimable by whoever reaches /login first). Seeding
 * servers and users ahead of the owner is exactly that state, so the seed has
 * to follow the sign-up. seedCore is idempotent (ON CONFLICT DO NOTHING /
 * UPDATE throughout), so a retried run is safe.
 */
setup('seed core fixtures after the owner exists', async () => {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await seedCore(client);
  } finally {
    await client.end();
  }
});
