import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }));

import { statfs } from 'node:fs/promises';
import {
  cacheWriteAllowed,
  noteCacheWrite,
  setCacheTallyBytes,
  takeRefusedWrites,
  readDiskSpace,
  writeDiskLimited,
  clearDiskLimited,
  readDiskLimited,
  _resetDiskSpaceMemoForTests,
  _resetGuardStateForTests,
} from '../imageCacheGuard.js';

const GB = 1024 ** 3;
const DIR = '/data/image-cache';

function mockDisk(freeBytes: number, totalBytes: number) {
  vi.mocked(statfs).mockResolvedValue({
    bsize: 4096,
    bavail: Math.floor(freeBytes / 4096),
    blocks: Math.floor(totalBytes / 4096),
  } as never);
}

describe('imageCacheGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetDiskSpaceMemoForTests();
    _resetGuardStateForTests();
    delete process.env.IMAGE_CACHE_MAX_MB;
    delete process.env.IMAGE_CACHE_MIN_FREE_PERCENT;
    _resetGuardStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a write that leaves more than the floor free', async () => {
    mockDisk(50 * GB, 100 * GB);
    expect(await cacheWriteAllowed(20 * 1024, DIR)).toBe(true);
    expect(takeRefusedWrites()).toBe(0);
  });

  it('refuses a write that would take free space under 10% of the volume, and counts it', async () => {
    mockDisk(10 * GB + 1024, 100 * GB);
    expect(await cacheWriteAllowed(4096, DIR)).toBe(false);
    expect(takeRefusedWrites()).toBe(1);
    expect(takeRefusedWrites()).toBe(0);
  });

  it('honours IMAGE_CACHE_MIN_FREE_PERCENT', async () => {
    process.env.IMAGE_CACHE_MIN_FREE_PERCENT = '25';
    _resetGuardStateForTests();
    mockDisk(20 * GB, 100 * GB);
    expect(await cacheWriteAllowed(1024, DIR)).toBe(false);
  });

  it('honours IMAGE_CACHE_MAX_MB as a ceiling on the tallied size', async () => {
    process.env.IMAGE_CACHE_MAX_MB = '1';
    _resetGuardStateForTests();
    mockDisk(50 * GB, 100 * GB);
    setCacheTallyBytes(1024 * 1024 - 100);
    expect(await cacheWriteAllowed(200, DIR)).toBe(false);
    setCacheTallyBytes(0);
    expect(await cacheWriteAllowed(200, DIR)).toBe(true);
    noteCacheWrite(1024 * 1024);
    expect(await cacheWriteAllowed(1, DIR)).toBe(false);
  });

  it('reads statfs at most once per 30 s per directory', async () => {
    mockDisk(50 * GB, 100 * GB);
    await readDiskSpace(DIR);
    await readDiskSpace(DIR);
    expect(statfs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await readDiskSpace(DIR);
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it('fails open when statfs throws', async () => {
    vi.mocked(statfs).mockRejectedValue(new Error('ENOSYS'));
    expect(await cacheWriteAllowed(1024, DIR)).toBe(true);
  });

  it('writes, keeps and clears the disk-limited flag', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    } as never;
    await writeDiskLimited(redis, 3, new Date('2026-08-23T10:00:00Z'));
    expect(await readDiskLimited(redis)).toEqual({
      since: '2026-08-23T10:00:00.000Z',
      shortfallBytes: 3 * 18 * 1024,
    });
    await writeDiskLimited(redis, 5, new Date('2026-08-23T11:00:00Z'));
    expect((await readDiskLimited(redis))?.since).toBe('2026-08-23T10:00:00.000Z');
    await clearDiskLimited(redis);
    expect(await readDiskLimited(redis)).toBeNull();
  });
});
