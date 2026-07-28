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

import { APIError } from 'better-auth/api';
import { SIGN_UP_USERNAME_PATH } from '@tracearr/shared';
import { buildSignupUserInput, linkCredentialAndCreateSession } from '../signupPlugin.js';
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
//
// This is also the empirical check for whether Better Auth dispatches
// ctx.path as exactly SIGN_UP_USERNAME_PATH for a plugin-registered endpoint
// under a configured basePath (the request below is sent WITH the basePath
// prefix, matching real traffic). If ctx.path ever carried the basePath
// prefix, or something else that doesn't exact-match the hook's comparison,
// the claim-code hook would silently stop matching this path (fail OPEN, no
// enforcement) and this test would see a 403 turn into a DB-connection
// failure instead - so a passing 403 here is the actual proof, not an
// assumption about better-auth's internals.
describe('POST /sign-up/username claim-code gate', () => {
  afterEach(async () => {
    resetClaimCode();
    delete process.env.CLAIM_CODE;
    await closeAuth();
  });

  it('rejects with 403 before touching the database when a claim code is required but missing', async () => {
    process.env.CLAIM_CODE = 'TEST-CODE-1234';
    initializeClaimCode();

    // Rate limiting is an explicit opt-out here (never an env-var side
    // effect, see BuildAuthOptions in auth.ts) - this suite drives real
    // requests through one in-process instance and doesn't want a per-IP
    // counter to interfere with the behavior under test.
    const auth = getAuth({ rateLimit: false });
    const req = new Request(`http://localhost${betterAuthBasePath()}${SIGN_UP_USERNAME_PATH}`, {
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

// Pins the compensation behavior: internalAdapter.createUser commits the
// user row on its own, so a failure in the two calls after it (linkAccount,
// createSession) must not leave that row orphaned with no credential -
// see the file header on signupPlugin.ts for why that permanently locks the
// instance out of local auth otherwise. All adapter calls are mocked so this
// runs with no Better Auth instance or database.
describe('linkCredentialAndCreateSession', () => {
  const passwordHash = 'hashed-password';
  const userId = 'user-1';

  function makeLogger() {
    return { error: vi.fn() };
  }

  it('links the credential, creates the session, and never deletes the user on success', async () => {
    const session = { token: 'session-token' };
    const adapter = {
      linkAccount: vi.fn().mockResolvedValue({}),
      createSession: vi.fn().mockResolvedValue(session),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    };
    const logger = makeLogger();

    const result = await linkCredentialAndCreateSession(adapter, { userId, passwordHash }, logger);

    expect(result).toBe(session);
    expect(adapter.linkAccount).toHaveBeenCalledWith({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash,
    });
    expect(adapter.createSession).toHaveBeenCalledWith(userId);
    expect(adapter.deleteUser).not.toHaveBeenCalled();
  });

  it('deletes the orphaned user and rethrows when linkAccount fails', async () => {
    const linkAccountError = new Error('transient DB error');
    const adapter = {
      linkAccount: vi.fn().mockRejectedValue(linkAccountError),
      createSession: vi.fn(),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    };
    const logger = makeLogger();

    await expect(
      linkCredentialAndCreateSession(adapter, { userId, passwordHash }, logger)
    ).rejects.toBeInstanceOf(APIError);

    expect(adapter.deleteUser).toHaveBeenCalledWith(userId);
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it('deletes the orphaned user and rethrows INTERNAL_SERVER_ERROR when createSession returns falsy', async () => {
    const adapter = {
      linkAccount: vi.fn().mockResolvedValue({}),
      createSession: vi.fn().mockResolvedValue(null),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    };
    const logger = makeLogger();

    const error = await linkCredentialAndCreateSession(
      adapter,
      { userId, passwordHash },
      logger
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe('INTERNAL_SERVER_ERROR');
    expect(adapter.deleteUser).toHaveBeenCalledWith(userId);
  });

  it('still rethrows the original failure when the compensating deleteUser itself fails', async () => {
    const linkAccountError = new Error('transient DB error');
    const deleteUserError = new Error('delete also failed');
    const adapter = {
      linkAccount: vi.fn().mockRejectedValue(linkAccountError),
      createSession: vi.fn(),
      deleteUser: vi.fn().mockRejectedValue(deleteUserError),
    };
    const logger = makeLogger();

    await expect(
      linkCredentialAndCreateSession(adapter, { userId, passwordHash }, logger)
    ).rejects.toBeInstanceOf(APIError);

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to compensate for incomplete sign-up (orphaned user)',
      deleteUserError
    );
  });
});
