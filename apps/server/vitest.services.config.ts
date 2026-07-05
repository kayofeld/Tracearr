/**
 * Services Tests Configuration
 *
 * Business logic and background job tests:
 * - services/* (rules, cache, geoip, userService, tautulli)
 * - jobs/* (aggregator, poller logic)
 *
 * May use mocks for external dependencies.
 *
 * Run: pnpm test:services
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'services',
      include: [
        'src/services/__tests__/*.test.ts',
        'src/services/**/__tests__/*.test.ts',
        'src/jobs/__tests__/*.test.ts',
        'src/jobs/poller/__tests__/*.test.ts',
        'src/db/__tests__/*.test.ts',
      ],
      // Integration tests need the live 5433 test database and its setup file
      // (vitest.integration.config.ts); the src/db glob above would otherwise
      // pull them in here without that environment.
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory: './coverage/services',
        include: ['src/services/**/*.ts', 'src/jobs/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/test/**',
          'src/services/mediaServer/**/*.ts', // Covered by unit tests
        ],
      },
    },
  })
);
