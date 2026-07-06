/**
 * Environment discovery + runtime module loading shared by the admin scripts
 * (cli.ts, reset-password.ts).
 *
 * The scripts are compiled into dist/scripts by the server build
 * (tsconfig.scripts.json), so in production they run as plain compiled JS
 * from dist/scripts/lib, exactly like the server itself. The raw TypeScript
 * sources also still run: via tsx against src/ in dev, or via Node's type
 * stripping against dist/ in the image (the historically documented
 * `node apps/server/scripts/...` invocation). This module figures out where
 * it is running from and dynamically imports the runtime pieces the scripts
 * need, so a single implementation works everywhere without a Docker
 * copy-step change every time a script touches a new module. KISS.
 */

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Load environment variables if DATABASE_URL is not already set.
 * in docker, we may have env variables set directly or via a .env file
 * in proxmox lxc, we rely on a .env file at /data/tracearr/.env
 * there may be other methods we need to support in the future
 */
export function loadEnv(): void {
  if (process.env.DATABASE_URL) return;

  const envPaths = [
    resolve(import.meta.dirname, '../../../../.env'), // raw scripts/lib: docker and dev
    resolve(import.meta.dirname, '../../../../../.env'), // compiled dist/scripts/lib: docker and dev
    '/data/tracearr/.env', // proxmox lxc
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
      if (process.env.DATABASE_URL) return;
    }
  }

  console.error('ERROR: DATABASE_URL environment variable not found.\n');
  console.error('Tried loading from:');
  for (const envPath of envPaths) {
    console.error(`  • ${envPath}`);
  }
  console.error('\nPlease ensure DATABASE_URL is set or one of these files exists.\n');
  process.exit(1);
}

/**
 * Locate the app runtime relative to where this file is running from:
 * raw scripts/lib next to src/ (dev via tsx), compiled dist/scripts/lib
 * inside dist/ (production), or raw scripts/lib next to a built dist/
 * (running the shipped .ts sources directly via Node type stripping).
 */
function basePath(): string {
  if (existsSync(resolve(import.meta.dirname, '../../src/db/client.ts'))) return '../../src';
  if (existsSync(resolve(import.meta.dirname, '../../db/client.js'))) return '../..';
  return '../../dist';
}

/**
 * Loads the DB/auth runtime pieces the admin commands need. Must be called
 * after (or via) loadEnv() so DATABASE_URL/REDIS_URL are populated before
 * the modules that read them at import time are loaded.
 */
export async function loadRuntime() {
  loadEnv();
  const base = basePath();

  const [dbModule, schema, passwordModule, settingsModule, redisModule] = await Promise.all([
    import(`${base}/db/client.js`),
    import(`${base}/db/schema.js`),
    import(`${base}/utils/password.js`),
    import(`${base}/services/settings.js`),
    import(`${base}/lib/redisShared.js`),
  ]);

  return {
    db: dbModule.db,
    closeDatabase: dbModule.closeDatabase,
    users: schema.users,
    authAccounts: schema.authAccounts,
    authSessions: schema.authSessions,
    plexAccounts: schema.plexAccounts,
    hashPassword: passwordModule.hashPassword,
    setSetting: settingsModule.setSetting,
    getSetting: settingsModule.getSetting,
    getRedis: redisModule.getRedis,
    closeRedis: redisModule.closeRedis,
  };
}
