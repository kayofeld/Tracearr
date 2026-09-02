import pg from 'pg';
import { e2eDatabaseUrl } from './env';
import { assertSafeDatabase } from './guard';
import { ensureDatabaseExists } from './ensureDatabase';
import { runMigrations } from './migrate';

/**
 * Playwright globalSetup: runs once, before any project. Bootstraps the
 * isolated e2e database (create if missing, migrate, safety-check) so
 * tracearr_e2e is ready before the webServer or the auth setup project ever
 * touches it. The bulk fixture data is NOT seeded here: it lands in the
 * 'core-seed' project after auth.setup.ts has created the owner, because the
 * fork refuses first-run sign-up on an instance that holds data but no owner.
 * See apps/e2e/README.md for the guard design and the seed phases.
 */
export default async function globalSetup(): Promise<void> {
  await ensureDatabaseExists();

  const databaseUrl = e2eDatabaseUrl();
  runMigrations(databaseUrl);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertSafeDatabase(client);
  } finally {
    await client.end();
  }
}
