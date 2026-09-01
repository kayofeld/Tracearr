import { describe, it, expect, vi } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';
import { reconcileImagePrecacheOnBoot, IMAGE_CACHE_SCHEMA_VERSION } from '../imagePrecacheBoot.js';

function deps(overrides: Partial<Parameters<typeof reconcileImagePrecacheOnBoot>[0]> = {}) {
  const calls: string[] = [];
  const store = new Map<string, string>();
  return {
    calls,
    store,
    deps: {
      queue: {
        obliterate: vi.fn(async () => {
          calls.push('obliterate');
        }),
      },
      redis: {
        get: vi.fn(async (k: string) => store.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => {
          calls.push('marker');
          store.set(k, v);
        }),
      },
      listServerIds: vi.fn(async () => ['s1', 's2']),
      enqueuePass: vi.fn(async (id: string) => {
        calls.push(`pass:${id}`);
        return `job-${id}`;
      }),
      sweep: vi.fn(async () => {
        calls.push('sweep');
      }),
      ...overrides,
    },
  };
}

describe('reconcileImagePrecacheOnBoot', () => {
  it('skips without Redis', async () => {
    const d = deps({ redis: null });
    expect(await reconcileImagePrecacheOnBoot(d.deps)).toEqual({ ran: false, passes: 0 });
    expect(d.deps.queue.obliterate).not.toHaveBeenCalled();
  });

  it('does nothing when the marker already says 2', async () => {
    const d = deps();
    d.store.set(REDIS_KEYS.IMAGE_CACHE_SCHEMA, IMAGE_CACHE_SCHEMA_VERSION);
    expect(await reconcileImagePrecacheOnBoot(d.deps)).toEqual({ ran: false, passes: 0 });
    expect(d.deps.queue.obliterate).not.toHaveBeenCalled();
  });

  it('obliterates, enqueues one pass per server, sweeps, then writes the marker, in that order', async () => {
    const d = deps();
    expect(await reconcileImagePrecacheOnBoot(d.deps)).toEqual({ ran: true, passes: 2 });
    expect(d.calls).toEqual(['obliterate', 'pass:s1', 'pass:s2', 'sweep', 'marker']);
    expect(d.store.get(REDIS_KEYS.IMAGE_CACHE_SCHEMA)).toBe(IMAGE_CACHE_SCHEMA_VERSION);
  });

  it('leaves the marker unset when the sweep throws, so the next boot retries', async () => {
    const d = deps({
      sweep: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(reconcileImagePrecacheOnBoot(d.deps)).rejects.toThrow('boom');
    expect(d.store.has(REDIS_KEYS.IMAGE_CACHE_SCHEMA)).toBe(false);
  });
});
