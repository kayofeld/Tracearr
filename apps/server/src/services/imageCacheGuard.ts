/**
 * Disk guard for the poster cache. The cache never evicts a current poster; it
 * stops writing instead, when free space would fall under the floor or the
 * optional ceiling is reached, and counts what it refused.
 */

import { statfs } from 'node:fs/promises';
import { REDIS_KEYS } from '@tracearr/shared';
import type { Redis } from 'ioredis';

export const ESTIMATED_POSTER_BYTES = 18 * 1024;
const DISK_SPACE_MEMO_MS = 30_000;

function readConfig(): { minFreePercent: number; maxBytes: number | null } {
  const percent = Number(process.env.IMAGE_CACHE_MIN_FREE_PERCENT);
  const mb = Number(process.env.IMAGE_CACHE_MAX_MB);
  return {
    minFreePercent: Number.isFinite(percent) && percent >= 0 && percent < 100 ? percent : 10,
    maxBytes: Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null,
  };
}

let config = readConfig();
let tallyBytes = 0;
let refusedWrites = 0;
const diskMemo = new Map<string, { at: number; freeBytes: number; totalBytes: number }>();

export function getGuardConfig(): { minFreePercent: number; maxBytes: number | null } {
  return config;
}

export async function readDiskSpace(
  dir: string
): Promise<{ freeBytes: number; totalBytes: number }> {
  const memo = diskMemo.get(dir);
  if (memo && Date.now() - memo.at < DISK_SPACE_MEMO_MS) {
    return { freeBytes: memo.freeBytes, totalBytes: memo.totalBytes };
  }
  const stats = await statfs(dir);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  diskMemo.set(dir, { at: Date.now(), freeBytes, totalBytes });
  return { freeBytes, totalBytes };
}

/** False when the write would breach the floor or the ceiling. A statfs failure fails open. */
export async function cacheWriteAllowed(bytes: number, dir: string): Promise<boolean> {
  if (config.maxBytes !== null && tallyBytes + bytes > config.maxBytes) {
    refusedWrites++;
    return false;
  }
  let space: { freeBytes: number; totalBytes: number };
  try {
    space = await readDiskSpace(dir);
  } catch {
    return true;
  }
  const floor = (space.totalBytes * config.minFreePercent) / 100;
  if (space.freeBytes - bytes < floor) {
    refusedWrites++;
    return false;
  }
  return true;
}

export function noteCacheWrite(bytes: number): void {
  tallyBytes += bytes;
}

export function setCacheTallyBytes(bytes: number): void {
  tallyBytes = bytes;
}

export function takeRefusedWrites(): number {
  const n = refusedWrites;
  refusedWrites = 0;
  return n;
}

export async function readDiskLimited(
  redis: Pick<Redis, 'get'>
): Promise<{ since: string; shortfallBytes: number } | null> {
  const raw = await redis.get(REDIS_KEYS.IMAGE_CACHE_DISK_LIMITED);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { since?: unknown; shortfallBytes?: unknown };
    if (typeof parsed.since !== 'string') return null;
    return {
      since: parsed.since,
      shortfallBytes: typeof parsed.shortfallBytes === 'number' ? parsed.shortfallBytes : 0,
    };
  } catch {
    return null;
  }
}

/** Keeps the first `since`; the shortfall is the latest pass's refused writes × 18 KB. */
export async function writeDiskLimited(
  redis: Pick<Redis, 'get' | 'set'>,
  refused: number,
  now: Date = new Date()
): Promise<void> {
  const existing = await readDiskLimited(redis);
  await redis.set(
    REDIS_KEYS.IMAGE_CACHE_DISK_LIMITED,
    JSON.stringify({
      since: existing?.since ?? now.toISOString(),
      shortfallBytes: refused * ESTIMATED_POSTER_BYTES,
    })
  );
}

export async function clearDiskLimited(redis: Pick<Redis, 'del'>): Promise<void> {
  await redis.del(REDIS_KEYS.IMAGE_CACHE_DISK_LIMITED);
}

export function _resetDiskSpaceMemoForTests(): void {
  diskMemo.clear();
}

export function _resetGuardStateForTests(): void {
  config = readConfig();
  tallyBytes = 0;
  refusedWrites = 0;
}
