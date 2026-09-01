/**
 * Database utilities for integration tests
 *
 * @module @tracearr/test-utils/db
 */

export { getTestPool, getTestDb, closeTestPool, executeRawSql } from './pool.js';
export { quote } from './sql.js';
export { setupTestDb, isTestDbReady, waitForTestDb } from './setup.js';
export { resetTestDb, teardownTestDb, truncateTables } from './reset.js';
export {
  seedBasicOwner,
  seedMultipleUsers,
  seedUserWithSessions,
  seedViolationScenario,
  seedMobilePairing,
  type SeedResult,
} from './seed.js';
