/**
 * Better Auth secondary storage atomicity (integration, real Redis)
 *
 * Exercises the PRODUCTION secondaryStorage object from lib/auth.ts against
 * the real test Redis. Better Auth 1.6.23 only builds an atomic rate-limit
 * `consume` when `increment` exists, and only consumes single-use
 * verification values atomically across processes when `getAndDelete`
 * exists; without them it falls back to non-atomic read-then-write paths
 * that lose writes under concurrency (multi-instance deployments share one
 * Redis, so a per-process lock does not cover it).
 *
 * Contract under test (from @better-auth/core SecondaryStorage):
 * - increment(key, ttl): atomically +1, return the post-increment value;
 *   TTL (seconds) applies only on creation and later increments never
 *   extend it.
 * - getAndDelete(key): atomically return the value and remove the key,
 *   null when absent.
 * Both must address Redis through the same rkey() prefix as get/set/delete.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getAuth, closeAuth } from '../../src/lib/auth.js';
import { getRedis } from '../../src/lib/redisShared.js';

const prefix = process.env.REDIS_PREFIX ?? '';
const rkey = (k: string) => `${prefix}tracearr:ba:${k}`;

const NS = 'storage-atomicity-spec';
const key = (name: string) => `${NS}:${name}`;

function storage() {
  const secondaryStorage = getAuth().options.secondaryStorage;
  if (!secondaryStorage) throw new Error('secondaryStorage missing from auth options');
  return secondaryStorage;
}

afterAll(async () => {
  const redis = getRedis();
  const keys = await redis.keys(rkey(`${NS}:*`));
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await closeAuth();
});

describe('secondaryStorage.increment', () => {
  it('creates the counter at 1 with the ttl applied, under the rkey prefix', async () => {
    const value = await storage().increment!(key('create'), 30);
    expect(value).toBe(1);

    const redis = getRedis();
    expect(await redis.get(rkey(key('create')))).toBe('1');
    // The bare (unprefixed) key must not exist: prefix parity with get/set.
    expect(await redis.exists(key('create'))).toBe(0);

    const ttl = await redis.ttl(rkey(key('create')));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('returns the post-increment value and never extends the ttl', async () => {
    await storage().increment!(key('window'), 30);
    const redis = getRedis();
    const ttlAfterCreate = await redis.ttl(rkey(key('window')));

    // Let the ttl tick down so a buggy re-EXPIRE is observable.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await storage().increment!(key('window'), 30);
    expect(second).toBe(2);

    const ttlAfterSecond = await redis.ttl(rkey(key('window')));
    expect(ttlAfterSecond).toBeLessThan(ttlAfterCreate);
  });

  it('counts every concurrent increment exactly once', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => storage().increment!(key('race'), 60))
    );

    // Atomicity: all post-increment values are distinct and reach exactly N.
    // The legacy read-then-write fallback loses writes here.
    expect(new Set(results).size).toBe(N);
    expect(Math.max(...results)).toBe(N);
    expect(await getRedis().get(rkey(key('race')))).toBe(String(N));
  });
});

describe('secondaryStorage.getAndDelete', () => {
  it('returns the stored value and removes the key', async () => {
    await storage().set(key('consume'), 'one-shot-value', 60);

    const value = await storage().getAndDelete!(key('consume'));
    expect(value).toBe('one-shot-value');
    expect(await getRedis().exists(rkey(key('consume')))).toBe(0);
  });

  it('returns null for a missing key', async () => {
    expect(await storage().getAndDelete!(key('absent'))).toBeNull();
  });

  it('yields the value to exactly one of two concurrent consumers', async () => {
    await storage().set(key('single-use'), 'state-token', 60);

    const [a, b] = await Promise.all([
      storage().getAndDelete!(key('single-use')),
      storage().getAndDelete!(key('single-use')),
    ]);

    const values = [a, b].filter((v) => v !== null);
    expect(values).toEqual(['state-token']);
  });
});
