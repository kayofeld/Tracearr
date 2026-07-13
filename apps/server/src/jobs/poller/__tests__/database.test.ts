/**
 * Rules cache tests
 *
 * getActiveRulesV2 caches its result in-process to avoid a full rules SELECT
 * on every poll tick / reconciliation / SSE event. Verifies write-through
 * invalidation and the TTL fallback for instances that never see another
 * instance's invalidation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

import { getActiveRulesV2, invalidateRulesCache } from '../database.js';

function ruleRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `rule-${id}`,
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    conditions: { all: [] },
    actions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockRulesResult(rows: ReturnType<typeof ruleRow>[]) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  });
}

describe('getActiveRulesV2 cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRulesCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only queries the database once for repeated reads within the TTL', async () => {
    mockRulesResult([ruleRow('r1')]);

    await getActiveRulesV2();
    await getActiveRulesV2();
    await getActiveRulesV2();

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('reflects a mutation immediately in-process once invalidated', async () => {
    mockRulesResult([ruleRow('r1')]);
    const first = await getActiveRulesV2();
    expect(first).toHaveLength(1);

    // Simulate a rule mutation route calling the invalidator after writing.
    mockRulesResult([ruleRow('r1'), ruleRow('r2')]);
    invalidateRulesCache();

    const second = await getActiveRulesV2();
    expect(second).toHaveLength(2);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('refetches once the TTL expires even without explicit invalidation', async () => {
    mockRulesResult([ruleRow('r1')]);
    await getActiveRulesV2();
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);

    mockRulesResult([ruleRow('r1'), ruleRow('r2')]);
    const afterTtl = await getActiveRulesV2();
    expect(afterTtl).toHaveLength(2);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('produces byte-identical rule output for a fixed rule set', async () => {
    const row = ruleRow('r1', {
      conditions: { all: [{ field: 'ip', op: 'eq', value: '1.2.3.4' }] },
    });
    mockRulesResult([row]);

    const first = await getActiveRulesV2();
    invalidateRulesCache();
    mockRulesResult([row]);
    const second = await getActiveRulesV2();

    expect(second).toEqual(first);
  });
});
