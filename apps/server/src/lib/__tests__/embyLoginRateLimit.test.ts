/**
 * Emby-login rate limit - bound to the REAL mounted endpoint
 *
 * Security review F4: the previous test only asserted the plugin's
 * rateLimit rule shape against its OWN hard-coded copy of the path literal
 * ('/emby/login'), so it kept passing even if the endpoint's real path
 * drifted away from the pathMatcher - a silent, unlimited endpoint. This
 * suite instead drives real requests through the actual Better Auth
 * instance (getAuth()) and its real request pipeline, and asserts the
 * (N+1)th request gets a 429 - proof the rule is bound to the endpoint
 * Better Auth actually dispatches to, not just a matching function in
 * isolation.
 *
 * No live Postgres/Redis is available in this environment: `../db/client.js`
 * is mocked (the diagnosis/login flow only needs it to fail fast with "no
 * server configured" well inside the rate limit's own decision, which runs
 * BEFORE the endpoint handler - see better-auth's onRequest pipeline) and
 * ioredis is replaced with the same in-memory FakeRedis used by
 * signupPlugin.test.ts, just enough for better-auth's secondary-storage
 * rate limiter (get/set/increment via two Lua scripts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EMBY_LOGIN_PATH } from '@tracearr/shared';

vi.mock('ioredis', () => {
  class FakeRedis {
    private store = new Map<string, string>();
    async get(key: string) {
      return this.store.get(key) ?? null;
    }
    async set(key: string, value: string) {
      this.store.set(key, value);
      return 'OK';
    }
    async del(...keys: string[]) {
      let count = 0;
      for (const key of keys) {
        if (this.store.delete(key)) count += 1;
      }
      return count;
    }
    // SAFE: this method name mirrors ioredis's own `eval()` client method,
    // which sends a Lua script to be run *inside Redis* over the wire - it
    // is unrelated to the JS global `eval()` and never executes `script` as
    // local JS code. The fake below only string-matches the two known,
    // fixed scripts auth.ts sends (INCREMENT_SCRIPT / GET_AND_DELETE_SCRIPT)
    // to fake their effect; it does not interpret or run Lua either.
    async eval(script: string, _numKeys: number, key: string, ...args: unknown[]) {
      if (script.includes('INCR')) {
        const next = Number(this.store.get(key) ?? '0') + 1;
        this.store.set(key, String(next));
        return next;
      }
      void args;
      const value = this.store.get(key) ?? null;
      if (value !== null) this.store.delete(key);
      return value;
    }
    async quit() {
      this.store.clear();
      return 'OK';
    }
  }
  return { Redis: FakeRedis };
});

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        // resolveConfiguredEmbyServerRow (SEC-02) orders by (createdAt, id)
        // before limiting - the chain must expose orderBy() or the real
        // handler throws a real TypeError instead of the intended "no
        // server configured" fail-fast this test relies on.
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]), // "no Emby server configured" - fails fast, no real connection
      };
      return chain;
    }),
  },
}));

import { getAuth, closeAuth } from '../auth.js';
import { betterAuthBasePath } from '../basePath.js';

function loginRequest() {
  return new Request(`http://localhost${betterAuthBasePath()}${EMBY_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'wrong-password' }),
  });
}

describe('POST /emby/login rate limit (real mount)', () => {
  afterEach(async () => {
    await closeAuth();
  });

  it('allows the first 5 attempts and rejects the 6th with 429', async () => {
    const auth = getAuth();

    for (let i = 0; i < 5; i++) {
      const res = await auth.handler(loginRequest());
      // 400 ("No Emby server is configured") is the real handler answering on
      // the mocked empty database. Asserting the exact status, rather than
      // merely `not 429`, is what pins the ENDPOINT to EMBY_LOGIN_PATH: a 404
      // would satisfy `not 429`, so if the route registration drifted off the
      // constant while the rate-limit matcher stayed on it, this loop would
      // still pass while the live endpoint fell back to the lenient default
      // limit. Rate-limit rules are evaluated before routing, so the 429 below
      // alone cannot prove the endpoint is mounted here.
      expect(res.status).toBe(400);
    }

    const sixth = await auth.handler(loginRequest());
    expect(sixth.status).toBe(429);
  });
});
