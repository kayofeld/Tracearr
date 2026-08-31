/**
 * Vitest test setup - runs before all tests
 *
 * This file sets up the test environment for unit/service/route tests.
 * It installs custom matchers from @tracearr/test-utils and sets up
 * environment variables.
 *
 * For integration tests that need database, use the integration config
 * which has additional setup for database lifecycle.
 */

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { installMatchers } from '@tracearr/test-utils/matchers';
import { resetAllFactoryCounters } from '@tracearr/test-utils/factories';
import { resetAllMocks } from '@tracearr/test-utils/mocks';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-chars-min';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/tracearr_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-32-chars!!';

// Install custom vitest matchers from test-utils
installMatchers();

// Silence console.log in tests unless DEBUG=true
if (!process.env.DEBUG) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'info').mockImplementation(() => {});
}

beforeAll(() => {
  // Global test setup
  process.env.TEST_INITIALIZED = 'true';
});

// Reset factories and mocks before each test for isolation
beforeEach(() => {
  resetAllFactoryCounters();
  resetAllMocks();
});

afterAll(() => {
  // Global test cleanup
  delete process.env.TEST_INITIALIZED;
});
