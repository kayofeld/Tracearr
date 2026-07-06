/**
 * Cleanup Mobile Tokens Job Tests
 *
 * Tests the mobile token cleanup job:
 * - Deletes expired unused tokens (older than 1 hour)
 * - Deletes used tokens (older than 30 days)
 * - Returns count of deleted tokens
 *
 * Uses mocked database to test cleanup logic in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    delete: vi.fn(),
  },
}));

// Import after mocking
import { db } from '../../db/client.js';
import { cleanupMobileTokens } from '../cleanupMobileTokens.js';

// Type the mocked db
const mockDb = db as unknown as {
  delete: ReturnType<typeof vi.fn>;
};

// Helper to create a mock delete chain
function mockDeleteChain(expiredResult: { id: string }[], usedResult: { id: string }[]) {
  let callCount = 0;

  mockDb.delete.mockImplementation(() => ({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(() => {
        callCount++;
        // First call is for expired tokens, second for used tokens
        return callCount === 1 ? expiredResult : usedResult;
      }),
    }),
  }));
}

describe('cleanupMobileTokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('expired unused tokens cleanup', () => {
    it('should delete expired unused tokens older than 1 hour', async () => {
      const expiredTokens = [{ id: randomUUID() }, { id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain(expiredTokens, []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(3);
      expect(mockDb.delete).toHaveBeenCalledTimes(2); // Both expired and used queries
    });
  });

  describe('used tokens cleanup', () => {
    it('should delete used tokens older than 30 days', async () => {
      const usedTokens = [{ id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain([], usedTokens);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(2);
    });
  });

  describe('combined cleanup', () => {
    it('should delete both expired and used tokens in single run', async () => {
      const expiredTokens = [{ id: randomUUID() }, { id: randomUUID() }];
      const usedTokens = [{ id: randomUUID() }, { id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain(expiredTokens, usedTokens);

      const result = await cleanupMobileTokens();

      // Total: 2 expired + 3 used = 5
      expect(result.deleted).toBe(5);
    });

    it('should return zero when no tokens need cleanup', async () => {
      mockDeleteChain([], []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(0);
    });
  });

  describe('cutoff arithmetic', () => {
    it('deletes unused tokens expired before now minus 1 hour and used tokens used before now minus 30 days', async () => {
      // beforeEach pins Date.now() to 2025-01-15T12:00:00Z
      const conditions: SQL[] = [];
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition: SQL) => {
          conditions.push(condition);
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      }));

      await cleanupMobileTokens();

      const dialect = new PgDialect();
      expect(conditions).toHaveLength(2);
      const expired = dialect.sqlToQuery(conditions[0]!);
      const used = dialect.sqlToQuery(conditions[1]!);

      expect(expired.sql).toContain('"expires_at" < $1');
      expect(expired.sql).toContain('"used_at" is null');
      expect(expired.params).toEqual(['2025-01-15T11:00:00.000Z']);

      expect(used.sql).toContain('"used_at" is not null');
      expect(used.sql).toContain('"used_at" < $1');
      expect(used.params).toEqual(['2024-12-16T12:00:00.000Z']);
    });
  });

  describe('error handling', () => {
    it('should propagate database errors for expired query', async () => {
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('Database connection failed')),
        }),
      });

      await expect(cleanupMobileTokens()).rejects.toThrow('Database connection failed');
    });

    it('should propagate database errors for used query', async () => {
      const returningMock = vi
        .fn()
        .mockResolvedValueOnce([]) // Expired query succeeds
        .mockRejectedValueOnce(new Error('Query timeout')); // Used query fails

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: returningMock,
        }),
      });

      await expect(cleanupMobileTokens()).rejects.toThrow('Query timeout');
    });
  });
});
