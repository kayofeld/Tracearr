/**
 * Automations cache tests
 *
 * getActiveAutomations caches its result in-process to avoid a full automations SELECT
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

const mockWarn = vi.fn();
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  automationsLogger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  defaultRecentSessionWindowHours,
  getActiveAutomations,
  invalidateAutomationsCache,
  mapAutomationRow,
  maxWindowHoursFromAutomations,
} from '../database.js';
import { evaluateRuleAsync } from '../../../services/automations/engine.js';
import type { EngineAutomation } from '@tracearr/shared';
import type { EvaluationContext } from '../../../services/automations/types.js';

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
    triggers: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockRulesResult(
  rows: ReturnType<typeof ruleRow>[],
  currentVersionId: string | null = null
) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () =>
          Promise.resolve(rows.map((automation) => ({ automation, currentVersionId }))),
      }),
    }),
  });
}

describe('getActiveAutomations cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAutomationsCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only queries the database once for repeated reads within the TTL', async () => {
    mockRulesResult([ruleRow('r1')]);

    await getActiveAutomations();
    await getActiveAutomations();
    await getActiveAutomations();

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('reflects a mutation immediately in-process once invalidated', async () => {
    mockRulesResult([ruleRow('r1')]);
    const first = await getActiveAutomations();
    expect(first).toHaveLength(1);

    // Simulate a rule mutation route calling the invalidator after writing.
    mockRulesResult([ruleRow('r1'), ruleRow('r2')]);
    invalidateAutomationsCache();

    const second = await getActiveAutomations();
    expect(second).toHaveLength(2);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('refetches once the TTL expires even without explicit invalidation', async () => {
    mockRulesResult([ruleRow('r1')]);
    await getActiveAutomations();
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);

    mockRulesResult([ruleRow('r1'), ruleRow('r2')]);
    const afterTtl = await getActiveAutomations();
    expect(afterTtl).toHaveLength(2);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('produces byte-identical rule output for a fixed rule set', async () => {
    const row = ruleRow('r1', {
      conditions: { all: [{ field: 'ip', op: 'eq', value: '1.2.3.4' }] },
    });
    mockRulesResult([row]);

    const first = await getActiveAutomations();
    invalidateAutomationsCache();
    mockRulesResult([row]);
    const second = await getActiveAutomations();

    expect(second).toEqual(first);
  });

  it('derives the default recent-session window from the cached rules', async () => {
    invalidateAutomationsCache();
    expect(defaultRecentSessionWindowHours()).toBe(24);

    mockRulesResult([
      ruleRow('r1', {
        conditions: {
          groups: [
            {
              conditions: [
                {
                  field: 'unique_ips_in_window',
                  operator: 'gte',
                  value: 3,
                  params: { window_hours: 72 },
                },
              ],
            },
          ],
        },
      }),
    ]);
    await getActiveAutomations();
    expect(defaultRecentSessionWindowHours()).toBe(72);

    invalidateAutomationsCache();
    expect(defaultRecentSessionWindowHours()).toBe(24);
  });
});

describe('mapAutomationRow triggers', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('carries the stored trigger nodes through to the cached rule', () => {
    const triggers = [
      {
        id: 'a1f0f0f0-0000-4000-8000-000000000001',
        type: 'session.paused' as const,
        enabled: true,
      },
    ];
    const mapped = mapAutomationRow(
      ruleRow('r1', { triggers }) as unknown as Parameters<typeof mapAutomationRow>[0],
      null
    );
    expect(mapped.triggers).toEqual(triggers);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reads a row that never held conditions or actions as empty ones', async () => {
    const row = ruleRow('r1', { conditions: null, actions: null }) as unknown as Parameters<
      typeof mapAutomationRow
    >[0];

    const mapped = mapAutomationRow(row, null);

    expect(mapped.conditions).toEqual({ groups: [] });
    expect(mapped.actions).toEqual({ actions: [] });

    // No checks means it matches, the same as an automation saved with none. Null is
    // malformed legacy data, and the boot migration backfills both columns.
    const result = await evaluateRuleAsync({
      session: null,
      serverUser: null,
      server: null,
      media: null,
      subjectKey: 'install',
      activeSessions: [],
      recentSessions: [],
      rule: mapped,
    } satisfies EvaluationContext);

    expect(result).toMatchObject({ matched: true, matchedGroups: [], actions: [] });
  });

  it('carries the automation version a run will be stamped with', async () => {
    invalidateAutomationsCache();
    mockRulesResult([ruleRow('r1')], 'ver-9');

    const [rule] = await getActiveAutomations();

    expect(rule?.currentVersionId).toBe('ver-9');
  });

  it('treats a row the migration never stamped as inert and warns once per rule', () => {
    const row = ruleRow('unmigrated', { triggers: null }) as unknown as Parameters<
      typeof mapAutomationRow
    >[0];

    expect(mapAutomationRow(row, null).triggers).toEqual([]);
    expect(mapAutomationRow(row, null).triggers).toEqual([]);
    expect(mapAutomationRow(row, null).triggers).toEqual([]);

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), {
      automationId: 'unmigrated',
      name: 'rule-unmigrated',
    });
  });
});

describe('maxWindowHoursFromAutomations', () => {
  const windowedRule = (windowHours?: number) =>
    ({
      conditions: {
        groups: [
          {
            conditions: [
              {
                field: 'unique_ips_in_window',
                operator: 'gte',
                value: 3,
                ...(windowHours !== undefined ? { params: { window_hours: windowHours } } : {}),
              },
            ],
          },
        ],
      },
    }) as EngineAutomation;

  it('defaults to 24 when no rule sets a window', () => {
    expect(maxWindowHoursFromAutomations([])).toBe(24);
    expect(maxWindowHoursFromAutomations([windowedRule()])).toBe(24);
  });

  it('returns the largest window across rules', () => {
    expect(
      maxWindowHoursFromAutomations([windowedRule(48), windowedRule(72), windowedRule(6)])
    ).toBe(72);
  });

  it('never drops below 24 for short windows', () => {
    expect(maxWindowHoursFromAutomations([windowedRule(2)])).toBe(24);
  });

  it('caps at 168 hours', () => {
    expect(maxWindowHoursFromAutomations([windowedRule(500)])).toBe(168);
  });
});
