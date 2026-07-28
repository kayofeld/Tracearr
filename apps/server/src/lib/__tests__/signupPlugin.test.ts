import { describe, it, expect, afterEach, vi } from 'vitest';

// getAuth() builds a real ioredis client (secondary storage + rate limiter).
// The claim-code-gate test below drives a real request through auth.handler(),
// which hits the rate limiter before hooks.before ever runs, so it needs a
// working (if fake) Redis rather than one that retries against an
// unreachable localhost:6379. In-memory fake, just enough for get/set/del and
// the two Lua scripts auth.ts's secondaryStorage.increment/getAndDelete run.
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
    // NOTE: this `eval` is ioredis's EVAL command (runs a Lua script *inside
    // Redis*), not the JS global `eval()` - no arbitrary local code execution
    // here. The fake only string-matches the script text to fake the two
    // known Lua scripts auth.ts sends (INCREMENT_SCRIPT / GET_AND_DELETE_SCRIPT);
    // it never executes `script` as code.
    async eval(script: string, _numKeys: number, key: string, ...args: unknown[]) {
      if (script.includes('INCR')) {
        const next = Number(this.store.get(key) ?? '0') + 1;
        this.store.set(key, String(next));
        return next;
      }
      // GET_AND_DELETE_SCRIPT
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

import { buildSignupUserInput } from '../signupPlugin.js';
import { getAuth, closeAuth } from '../auth.js';
import { betterAuthBasePath } from '../basePath.js';
import { initializeClaimCode, resetClaimCode } from '../../utils/claimCode.js';

describe('buildSignupUserInput', () => {
  it('omits email entirely when none is supplied', () => {
    const result = buildSignupUserInput({ name: 'New Owner', username: 'newowner' });
    expect(result).toEqual({ name: 'New Owner', username: 'newowner' });
    expect('email' in result).toBe(false);
  });

  it('omits email when it is blank/whitespace-only, never storing an empty string', () => {
    const result = buildSignupUserInput({ name: 'New Owner', username: 'newowner', email: '   ' });
    expect('email' in result).toBe(false);
  });

  it('trims and lower-cases a supplied email', () => {
    const result = buildSignupUserInput({
      name: 'New Owner',
      username: 'newowner',
      email: '  Owner@Example.COM  ',
    });
    expect(result.email).toBe('owner@example.com');
  });

  it('never includes an empty-string email key', () => {
    for (const email of [undefined, '', '   ', '\t']) {
      const result = buildSignupUserInput({ name: 'n', username: 'u', email });
      expect(result.email).not.toBe('');
    }
  });
});

// Exercises the real (unmocked) Better Auth instance so the claim-code gate
// centralized in auth.ts's hooks.before is proven to also cover the new
// /sign-up/username path, not just the built-in /sign-up/email. A missing
// claim code must be rejected before any database call - if the ctx.path
// check in auth.ts were never extended to this path, the request would
// instead reach internalAdapter.createUser and fail with a DB-connection
// error (this suite runs without a live Postgres), never a clean 403 - so a
// 403 here is a meaningful regression signal for the auth.ts wiring, not a
// coincidence of the unreachable DB.
describe('POST /sign-up/username claim-code gate', () => {
  afterEach(async () => {
    resetClaimCode();
    delete process.env.CLAIM_CODE;
    await closeAuth();
  });

  it('rejects with 403 before touching the database when a claim code is required but missing', async () => {
    process.env.CLAIM_CODE = 'TEST-CODE-1234';
    initializeClaimCode();

    const auth = getAuth();
    const req = new Request(`http://localhost${betterAuthBasePath()}/sign-up/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'New Owner',
        username: 'newowner',
        password: 'SuperSecret123!',
      }),
    });

    const res = await auth.handler(req);
    expect(res.status).toBe(403);
  });
});
