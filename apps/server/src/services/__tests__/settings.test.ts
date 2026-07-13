/**
 * Settings cache tests
 *
 * getSetting() is read once per server per poll tick (getGeoIPSettings), so
 * results are cached in-process. Verifies write-through updates from
 * setSetting/setSettings and the TTL fallback for multi-instance staleness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const mockDbInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: () => ({ values: mockDbInsertValues }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({ values: mockDbInsertValues }),
      };
      await fn(tx);
    },
  },
}));

vi.mock('../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

import { getGeoIPSettings, getSetting, resetSettingsCache, setSetting } from '../settings.js';

function mockSettingRow(value: unknown) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(value === undefined ? [] : [{ value }]),
      }),
    }),
  });
}

describe('settings cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsCache();
    mockDbInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only queries the database once for repeated reads within the TTL', async () => {
    mockSettingRow(true);

    await getSetting('usePlexGeoip');
    await getSetting('usePlexGeoip');
    await getGeoIPSettings();

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('reflects a setSetting write immediately in-process, within one write', async () => {
    mockSettingRow(false);
    const before = await getGeoIPSettings();
    expect(before.usePlexGeoip).toBe(false);

    await setSetting('usePlexGeoip', true);

    const after = await getGeoIPSettings();
    expect(after.usePlexGeoip).toBe(true);
    // The write-through cache update means no extra SELECT was needed.
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL expires even without an explicit write', async () => {
    mockSettingRow(false);
    await getSetting('usePlexGeoip');
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);

    mockSettingRow(true);
    const value = await getSetting('usePlexGeoip');
    expect(value).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });
});
