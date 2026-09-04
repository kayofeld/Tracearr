/**
 * Pre-migration reconciliation for databases created by the pre-v2 fork
 * (Tracearr v1.8.0 ... v1.13.0 of this repository).
 *
 * Why this exists
 * ---------------
 * Drizzle's migrator decides what to apply from a single row:
 *
 *   select id, hash, created_at from drizzle.__drizzle_migrations
 *     order by created_at desc limit 1
 *
 * and then applies every journal entry whose `folderMillis` is GREATER than
 * that one value. It is a high-water mark, not a set of applied migrations.
 *
 * The fork carried five migrations of its own (0067..0071) that were authored
 * after it branched from upstream 0066. Their timestamps (1785251293080 ...
 * 1785397613726) are LATER than upstream's own 0067..0076
 * (1784125742617 ... 1785249058410), which the fork only inherited when it
 * merged upstream v2. So on any fork database the high-water mark already
 * sits above ten upstream migrations that were never applied: drizzle skips
 * them silently and starts at 0077, and the first migration that depends on
 * one of the skipped ones fails the whole batch. In practice that is 0078,
 * which reads library_items.video_dynamic_range - a column added by the
 * skipped 0075:
 *
 *   column "video_dynamic_range" does not exist
 *
 * The batch is one transaction, so a database in this state is not damaged:
 * it stays exactly where it was and the server sits in maintenance mode,
 * retrying and failing the same way on every boot.
 *
 * What this does
 * --------------
 * It removes the five fork rows from the ledger, which drops the high-water
 * mark back to upstream 0066 and lets drizzle apply 0067..0097 in order, the
 * way it would on any other database. Two of those migrations would then meet
 * objects the fork had already created under its own numbering, so they are
 * idempotent (0074_add_libraries_table, 0097_fork_media_requests_and_played_state)
 * and this module first reshapes what the fork left behind so those two
 * recognise their own objects:
 *
 *   - `libraries` (fork 0069) is altered in place into the shape upstream 0074
 *     creates, keeping the rows;
 *   - constraint and index names left by the fork's ombi_* -> media_* rename
 *     are aligned with what a fresh install has;
 *   - on a database from before the fork's own 0068 rename (v1.8.x only), the
 *     legacy ombi_* mirror tables are parked under a *_legacy name rather than
 *     reshaped: they are a mirror of Ombi that the next sync rebuilds, and
 *     parking them is far less machinery than replaying a rename nobody needs.
 *
 * Everything runs in one transaction. On failure nothing is applied and the
 * caller's migration attempt fails as it did before, which is the behaviour a
 * retry loop already handles.
 *
 * This is deliberately keyed to fixed, historical timestamps: it is a one-time
 * repair of five specific ledger rows, not a general mechanism. Once the rows
 * are gone the check at the top costs one indexed count per boot and the
 * function returns. It is safe on an already-reconciled database (the seedbox
 * instance was repaired by hand before this existed): every step is guarded,
 * and removing the leftover fork rows there changes nothing drizzle reads.
 */

import type pg from 'pg';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('fork-ledger');

/**
 * `created_at` of the fork's own migrations 0067..0071, in journal order:
 * black_sway, generalize_media_requests, add_libraries_table,
 * auth_integrity_partial_indexes, played_state_mirror. These values only ever
 * existed in this fork; upstream never issued them.
 */
export const FORK_LEDGER_MILLIS = [
  1785251293080, 1785265909003, 1785276421708, 1785345444023, 1785397613726,
] as const;

/**
 * Reshape a fork database so the upstream migrations it never ran can run, and
 * drop the ledger rows that were hiding them. No-op on every other database.
 *
 * @returns true when a reconciliation was applied.
 */
export async function reconcileForkLedger(client: pg.Client): Promise<boolean> {
  const ledgerExists = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`
  );
  if (!ledgerExists.rows[0]?.present) return false;

  const forkRows = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])`,
    [[...FORK_LEDGER_MILLIS]]
  );
  if (Number(forkRows.rows[0]?.count ?? 0) === 0) return false;

  logger.warn(
    'Fork-era migration ledger detected; reconciling so the upstream migrations it hid can be applied'
  );

  await client.query('BEGIN');
  try {
    // 1. libraries: the fork's 0069 shape -> the shape upstream 0074 creates.
    // Rows are kept; only the column that was renamed (type -> media_type),
    // widened (name varchar(255) -> text) and dropped (created_at) differ.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'type'
        ) THEN
          ALTER TABLE "libraries" RENAME COLUMN "type" TO "media_type";
          ALTER TABLE "libraries" ALTER COLUMN "name" TYPE text;
          ALTER TABLE "libraries" DROP COLUMN IF EXISTS "created_at";
        END IF;
      END $$;
    `);

    // 2. A database from before the fork's 0068 rename still has the ombi_*
    // tables. Park them: 0097 then creates media_requests/media_request_user_mappings
    // empty and the next Ombi sync refills the mirror. Nothing is dropped, so
    // the old rows stay available if anyone wants them.
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        IF to_regclass('public.ombi_requests') IS NOT NULL
           AND to_regclass('public.media_requests') IS NULL THEN
          ALTER TABLE "ombi_requests" RENAME TO "ombi_requests_legacy";
          IF to_regclass('public.ombi_user_mappings') IS NOT NULL THEN
            ALTER TABLE "ombi_user_mappings" RENAME TO "ombi_user_mappings_legacy";
          END IF;
          -- Renaming a table leaves its constraints and indexes under their old
          -- names, and Postgres keeps those names in one namespace per schema.
          -- Any of them already called media_request* would collide with what
          -- 0097 is about to create, so they follow the table aside.
          FOR r IN
            SELECT conname AS name, conrelid::regclass::text AS tbl, true AS is_constraint
              FROM pg_constraint
             WHERE conrelid::regclass::text IN ('ombi_requests_legacy', 'ombi_user_mappings_legacy')
               AND conname LIKE 'media\\_request%'
            UNION ALL
            SELECT indexname, tablename, false
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename IN ('ombi_requests_legacy', 'ombi_user_mappings_legacy')
               AND indexname LIKE 'media\\_request%'
               AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conname IS NOT NULL)
          LOOP
            IF r.is_constraint THEN
              EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.name, r.name || '_legacy');
            ELSE
              EXECUTE format('ALTER INDEX %I RENAME TO %I', r.name, r.name || '_legacy');
            END IF;
          END LOOP;
        END IF;
      END $$;
    `);

    // 3. Names the fork's renames left behind, aligned with a fresh install.
    // Cosmetic for behaviour, but it keeps a reconciled database and a fresh
    // one comparable - which is how this whole class of drift gets noticed.
    await client.query(`
      DO $$
      BEGIN
        -- renaming the index renames the primary-key constraint with it
        IF to_regclass('public.media_requests') IS NOT NULL
           AND to_regclass('public.ombi_requests_pkey') IS NOT NULL THEN
          ALTER INDEX "ombi_requests_pkey" RENAME TO "media_requests_pkey";
        END IF;
        -- the not-null constraint on libraries.type kept its old name through
        -- the column rename in step 1 (Postgres 17+ names these in the catalog)
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'libraries_type_not_null') THEN
          ALTER TABLE "libraries" RENAME CONSTRAINT "libraries_type_not_null" TO "libraries_media_type_not_null";
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT c.conname, c.conrelid::regclass::text AS tbl, a.attname
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'n'
            AND c.conrelid::regclass::text IN ('media_requests', 'media_request_user_mappings', 'libraries')
            AND c.conname !~ ('^' || c.conrelid::regclass::text || '_')
        LOOP
          EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                         r.tbl, r.conname, r.tbl || '_' || r.attname || '_not_null');
        END LOOP;
      END $$;
    `);

    // 4. Drop the fork rows. This is what actually unblocks the migrator: the
    // high-water mark falls back to upstream 0066 and every entry above it is
    // applied in journal order.
    const deleted = await client.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])`,
      [[...FORK_LEDGER_MILLIS]]
    );
    const highWater = await client.query<{ created_at: string | null }>(
      `SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations`
    );

    await client.query('COMMIT');
    logger.info('Fork-era migration ledger reconciled; upstream migrations will now be applied', {
      removedLedgerRows: deleted.rowCount ?? 0,
      resumingAfter: highWater.rows[0]?.created_at ?? null,
    });
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the failure below is the one worth reporting */
    });
    throw error;
  }
}
