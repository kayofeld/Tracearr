/**
 * One-time reconciliation after the 2.2 poster cache change: the backed-up queue
 * of interleaved passes is emptied, one fresh pass per server is queued, and the
 * sweep removes the old 160/240 copies before the worker starts.
 */

import { REDIS_KEYS } from '@tracearr/shared';

export const IMAGE_CACHE_SCHEMA_VERSION = '2';

export interface BootDeps {
  queue: { obliterate(opts: { force: boolean }): Promise<void> };
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
  } | null;
  listServerIds: () => Promise<string[]>;
  enqueuePass: (serverId: string) => Promise<string | undefined>;
  sweep: () => Promise<unknown>;
}

export async function reconcileImagePrecacheOnBoot(
  deps: BootDeps
): Promise<{ ran: boolean; passes: number }> {
  if (!deps.redis) {
    console.warn('[ImagePrecache] no Redis; boot reconciliation deferred to the next boot');
    return { ran: false, passes: 0 };
  }
  const marker = await deps.redis.get(REDIS_KEYS.IMAGE_CACHE_SCHEMA);
  if (marker === IMAGE_CACHE_SCHEMA_VERSION) return { ran: false, passes: 0 };

  await deps.queue.obliterate({ force: true });
  let passes = 0;
  for (const serverId of await deps.listServerIds()) {
    if (await deps.enqueuePass(serverId)) passes++;
  }
  await deps.sweep();
  await deps.redis.set(REDIS_KEYS.IMAGE_CACHE_SCHEMA, IMAGE_CACHE_SCHEMA_VERSION);
  console.log(`[ImagePrecache] boot reconciliation: queue emptied, ${passes} passes queued`);
  return { ran: true, passes };
}
