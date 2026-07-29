import type * as AuthGuardsModule from '../authGuards.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { EMBY_SETUP_PATH } from '@tracearr/shared';
import {
  canonicalizeSetupUrl,
  SetupUrlRejectedError,
  runEmbySetup,
  EmbySetupError,
  acquireSetupProbeSlot,
  releaseSetupProbeSlot,
  resetSetupProbeSlotsForTests,
  MAX_CONCURRENT_SETUP_PROBES,
  type EmbySetupPorts,
  type EmbySetupInput,
} from '../embySetupPlugin.js';

// CR-1 boundary fixture (getAuth() builds a real ioredis client for
// secondary storage + the rate limiter). In-memory fake, same shape as
// signupPlugin.test.ts's - just enough for get/set/del and the two Lua
// scripts auth.ts's secondaryStorage.increment/getAndDelete send.
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
    // known Lua scripts auth.ts sends; it never executes `script` as code.
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

// Only getInstanceClaimState is overridden (per-test, via vi.mocked below) so
// the CR-1 boundary test can force a state deterministically without a live
// Postgres; every other export (assertSignupAllowed, assertClaimCode, the
// OWNERLESS_* constants embySetupPlugin.ts itself imports) stays real.
vi.mock('../authGuards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthGuardsModule>();
  return { ...actual, getInstanceClaimState: vi.fn() };
});

/**
 * CR-2 fixture: the REAL shape drizzle-orm 0.45's node-postgres driver
 * produces for a unique_violation - `DrizzleQueryError`'s own `.message`
 * never contains the constraint name (drizzle-orm/errors.js); the pg
 * `DatabaseError` (carrying `.code`/`.constraint`) lives at `.cause` (see
 * utils/dbErrors.ts and its test for the full contract). A bare `Error` with
 * the constraint name IN the message - the pre-fix fixture here - is a shape
 * drizzle never actually produces, so it can never reach isUniqueViolationOn
 * through a real `createOwnerUser`/internalAdapter.createUser insert.
 */
function makeWrappedUniqueViolation(constraint: string): DrizzleQueryError {
  const cause = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  ) as Error & { code: string; constraint: string };
  cause.code = '23505';
  cause.constraint = constraint;
  return new DrizzleQueryError('insert into "user" ...', [], cause);
}

describe('canonicalizeSetupUrl', () => {
  it('returns the origin for a plain http URL', () => {
    expect(canonicalizeSetupUrl('http://192.168.1.10:8096')).toBe('http://192.168.1.10:8096');
  });

  it('lowercases the host', () => {
    expect(canonicalizeSetupUrl('http://EMBY.LOCAL:8096')).toBe('http://emby.local:8096');
  });

  it('drops the default port for http', () => {
    expect(canonicalizeSetupUrl('http://emby.local:80')).toBe('http://emby.local');
  });

  it('drops the default port for https', () => {
    expect(canonicalizeSetupUrl('https://emby.local:443')).toBe('https://emby.local');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizeSetupUrl('https://emby.local:8920')).toBe('https://emby.local:8920');
  });

  it('rejects a malformed URL', () => {
    expect(() => canonicalizeSetupUrl('not a url')).toThrow(SetupUrlRejectedError);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => canonicalizeSetupUrl('ftp://emby.local')).toThrow(SetupUrlRejectedError);
  });

  it('rejects userinfo (SEC-09) rather than stripping it', () => {
    expect(() => canonicalizeSetupUrl('http://user:pass@emby.local:8096')).toThrow(
      SetupUrlRejectedError
    );
  });

  it('rejects a query string', () => {
    expect(() => canonicalizeSetupUrl('http://emby.local:8096?x=1')).toThrow(SetupUrlRejectedError);
  });

  it('rejects a fragment', () => {
    expect(() => canonicalizeSetupUrl('http://emby.local:8096#frag')).toThrow(
      SetupUrlRejectedError
    );
  });

  it('rejects a path beyond root', () => {
    expect(() => canonicalizeSetupUrl('http://emby.local:8096/web/index.html')).toThrow(
      SetupUrlRejectedError
    );
  });
});

function makePorts(overrides: Partial<EmbySetupPorts> = {}): EmbySetupPorts {
  return {
    getClaimState: vi.fn().mockResolvedValue('unclaimed'),
    verifyServerAdmin: vi.fn().mockResolvedValue({ success: true }),
    authenticate: vi
      .fn()
      .mockResolvedValue({ id: 'emby-user-1', token: 'emby-token', isAdmin: true }),
    createOwnerUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    insertServer: vi
      .fn()
      .mockResolvedValue({ id: 'server-1', name: 'Emby', url: 'http://emby.local:8096' }),
    linkEmbyAccount: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ token: 'session-token' }),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn(),
    ...overrides,
  };
}

const BASE_INPUT: EmbySetupInput = {
  serverUrl: 'http://emby.local:8096',
  serverName: 'My Emby',
  apiKey: 'admin-api-key',
  username: 'owner',
  password: 'super-secret-password',
};

describe('runEmbySetup', () => {
  describe('the `owned` state', () => {
    it('refuses with INSTANCE_OWNED before touching any other port', async () => {
      const ports = makePorts({ getClaimState: vi.fn().mockResolvedValue('owned') });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EmbySetupError);
      expect((error as EmbySetupError).code).toBe('INSTANCE_OWNED');
      expect((error as EmbySetupError).httpStatus).toBe(403);
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
      expect(ports.createOwnerUser).not.toHaveBeenCalled();
    });
  });

  describe('the `ownerless-with-data` state (CR-3/IMP-01: console-only recovery, no network adoption)', () => {
    it('refuses with INSTANCE_RECOVERY unconditionally, before any outbound call, regardless of claim code or input', async () => {
      const ports = makePorts({ getClaimState: vi.fn().mockResolvedValue('ownerless-with-data') });

      // An attacker-supplied URL (or any input at all) must make no
      // difference: the state alone decides, before canonicalization,
      // before verifyServerAdmin, before authenticate.
      const attackerInput: EmbySetupInput = {
        ...BASE_INPUT,
        serverUrl: 'http://attacker.example.com/',
      };

      const error = await runEmbySetup(attackerInput, ports).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EmbySetupError);
      expect((error as EmbySetupError).code).toBe('INSTANCE_RECOVERY');
      expect((error as EmbySetupError).httpStatus).toBe(403);
      expect(ports.logError).toHaveBeenCalledWith(
        expect.stringContaining('OWNERLESS_INSTANCE_WITH_DATA')
      );
      // No outbound call of any kind - the operator's Emby credentials for
      // this request are never sent anywhere, and nothing is ever inserted,
      // updated, or created.
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
      expect(ports.authenticate).not.toHaveBeenCalled();
      expect(ports.createOwnerUser).not.toHaveBeenCalled();
      expect(ports.insertServer).not.toHaveBeenCalled();
    });
  });

  describe('the `unclaimed` state - URL vetting', () => {
    it('rejects a malformed/rejected client URL with URL_REJECTED before any outbound call', async () => {
      const ports = makePorts();
      const input: EmbySetupInput = { ...BASE_INPUT, serverUrl: 'http://user:pass@emby.local' };

      const error = await runEmbySetup(input, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('URL_REJECTED');
      expect((error as EmbySetupError).httpStatus).toBe(400);
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
    });

    it('CR-7: rejects a denied-literal-address URL (SSRF deny list) with URL_REJECTED (400), never SERVER_UNREACHABLE (503), before any outbound call', async () => {
      const ports = makePorts();
      // 169.254.169.254 is the cloud metadata address ssrf.ts's deny list
      // blocks outright - a valid, well-formed URL that canonicalizeSetupUrl
      // alone (scheme/userinfo/query/fragment/path only) would happily pass.
      const input: EmbySetupInput = { ...BASE_INPUT, serverUrl: 'http://169.254.169.254:8096' };

      const error = await runEmbySetup(input, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('URL_REJECTED');
      expect((error as EmbySetupError).httpStatus).toBe(400);
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
    });
  });

  describe('server verification failures', () => {
    it('maps CONNECTION_FAILED to SERVER_UNREACHABLE (503)', async () => {
      const ports = makePorts({
        verifyServerAdmin: vi
          .fn()
          .mockResolvedValue({ success: false, code: 'CONNECTION_FAILED', message: 'unreachable' }),
      });
      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('SERVER_UNREACHABLE');
      expect((error as EmbySetupError).httpStatus).toBe(503);
    });

    it('maps INVALID_KEY to KEY_REJECTED (401)', async () => {
      const ports = makePorts({
        verifyServerAdmin: vi
          .fn()
          .mockResolvedValue({ success: false, code: 'INVALID_KEY', message: 'bad key' }),
      });
      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('KEY_REJECTED');
      expect((error as EmbySetupError).httpStatus).toBe(401);
    });

    it('maps any other failure code to KEY_NOT_ADMIN (403)', async () => {
      const ports = makePorts({
        verifyServerAdmin: vi
          .fn()
          .mockResolvedValue({ success: false, code: 'NOT_ADMIN', message: 'not admin' }),
      });
      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('KEY_NOT_ADMIN');
      expect((error as EmbySetupError).httpStatus).toBe(403);
    });
  });

  describe('human authentication failures', () => {
    it('maps a null auth result to BAD_CREDENTIALS (401)', async () => {
      const ports = makePorts({ authenticate: vi.fn().mockResolvedValue(null) });
      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('BAD_CREDENTIALS');
      expect((error as EmbySetupError).httpStatus).toBe(401);
    });

    it('maps isAdmin: false to NOT_EMBY_ADMIN (403)', async () => {
      const ports = makePorts({
        authenticate: vi.fn().mockResolvedValue({ id: 'u1', token: 't', isAdmin: false }),
      });
      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('NOT_EMBY_ADMIN');
      expect((error as EmbySetupError).httpStatus).toBe(403);
    });
  });

  describe('the happy path (unclaimed)', () => {
    it('creates the user, inserts the server, links the account, creates a session, and returns the shared EmbySetupResult shape', async () => {
      const ports = makePorts();

      const result = await runEmbySetup(BASE_INPUT, ports);

      expect(ports.createOwnerUser).toHaveBeenCalledWith('owner');
      expect(ports.insertServer).toHaveBeenCalledWith({
        name: 'My Emby',
        url: 'http://emby.local:8096',
        token: 'admin-api-key',
      });
      expect(ports.linkEmbyAccount).toHaveBeenCalledWith({
        userId: 'user-1',
        accountId: 'emby-user-1',
        accessToken: 'emby-token',
      });
      expect(ports.createSession).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({
        authorized: true,
        user: { id: 'user-1', username: 'owner', role: 'owner' },
        server: { id: 'server-1', name: 'Emby', url: 'http://emby.local:8096' },
      });
    });

    it('defaults the server name to "Emby" when none is supplied', async () => {
      const ports = makePorts();
      const input: EmbySetupInput = { ...BASE_INPUT, serverName: undefined };

      await runEmbySetup(input, ports);

      expect(ports.insertServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'Emby' }));
    });
  });

  describe('the single-owner race (SEC-04/SEC-05 parity)', () => {
    it('maps a users_single_owner unique violation to INSTANCE_OWNED with no compensation', async () => {
      const ports = makePorts({
        createOwnerUser: vi
          .fn()
          .mockRejectedValue(makeWrappedUniqueViolation('users_single_owner')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('INSTANCE_OWNED');
      expect((error as EmbySetupError).httpStatus).toBe(403);
      expect(ports.deleteServer).not.toHaveBeenCalled();
      expect(ports.deleteUser).not.toHaveBeenCalled();
      expect(ports.insertServer).not.toHaveBeenCalled();
    });

    it('IMP-05: maps a servers_single_emby unique violation on insertServer to INSTANCE_RECOVERY (never a raw SETUP_FAILED 500), compensating the created user', async () => {
      const ports = makePorts({
        insertServer: vi.fn().mockRejectedValue(makeWrappedUniqueViolation('servers_single_emby')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('INSTANCE_RECOVERY');
      expect((error as EmbySetupError).httpStatus).toBe(403);
      // This attempt's own user row is compensated; no server was inserted
      // by this attempt, so nothing to delete there.
      expect(ports.deleteUser).toHaveBeenCalledWith('user-1');
      expect(ports.deleteServer).not.toHaveBeenCalled();
    });
  });

  describe('compensation on partial failure (§7.3)', () => {
    it('deletes the created user but not any server (none was inserted) when insertServer fails, and surfaces SETUP_FAILED', async () => {
      const ports = makePorts({
        insertServer: vi.fn().mockRejectedValue(new Error('db write failed')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('SETUP_FAILED');
      expect((error as EmbySetupError).httpStatus).toBe(500);
      expect(ports.deleteUser).toHaveBeenCalledWith('user-1');
      expect(ports.deleteServer).not.toHaveBeenCalled();
    });

    it('CR-9/IMP-06: logs the ORIGINAL cause (message + requestId + claimState), never the raw error object', async () => {
      const ports = makePorts({
        insertServer: vi.fn().mockRejectedValue(new Error('db write failed: connection reset')),
      });

      await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect(ports.logError).toHaveBeenCalledWith(
        expect.stringContaining('Emby setup failed'),
        expect.objectContaining({
          requestId: expect.any(String),
          claimState: 'unclaimed',
          cause: 'db write failed: connection reset',
        })
      );
      // Never the raw Error object itself under any key.
      const calls = (ports.logError as ReturnType<typeof vi.fn>).mock.calls;
      const matchingCall = calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('Emby setup failed')
      );
      const loggedContext = matchingCall?.[1] as Record<string, unknown> | undefined;
      for (const value of Object.values(loggedContext ?? {})) {
        expect(value).not.toBeInstanceOf(Error);
      }
    });

    it('deletes both the inserted server and the user, in reverse order, when linking the Emby account fails', async () => {
      const ports = makePorts({
        linkEmbyAccount: vi.fn().mockRejectedValue(new Error('link failed')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('SETUP_FAILED');
      expect(ports.deleteServer).toHaveBeenCalledWith('server-1');
      expect(ports.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('compensates and fails when createSession returns null', async () => {
      const ports = makePorts({ createSession: vi.fn().mockResolvedValue(null) });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('SETUP_FAILED');
      expect(ports.deleteServer).toHaveBeenCalledWith('server-1');
      expect(ports.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('logs a greppable recovery marker (never masking the original failure) when compensation itself fails', async () => {
      const ports = makePorts({
        linkEmbyAccount: vi.fn().mockRejectedValue(new Error('link failed')),
        deleteServer: vi.fn().mockRejectedValue(new Error('cleanup also failed')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('SETUP_FAILED');
      expect(ports.logError).toHaveBeenCalledWith(
        expect.stringContaining('INSTANCE REQUIRES MANUAL RECOVERY'),
        expect.objectContaining({ err: expect.any(Error) })
      );
    });

    describe('CR-5: the recovery log names the command matching what actually survives', () => {
      it('points at `reset-password` (never `promote-owner`) when the owner USER row survives (delete failed)', async () => {
        const userDeleteErr = new Error('user delete failed');
        const ports = makePorts({
          linkEmbyAccount: vi.fn().mockRejectedValue(new Error('link failed')),
          deleteUser: vi.fn().mockRejectedValue(userDeleteErr),
        });

        await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

        expect(ports.logError).toHaveBeenCalledWith(
          expect.stringMatching(/reset-password/),
          expect.objectContaining({ err: userDeleteErr })
        );
        expect(ports.logError).not.toHaveBeenCalledWith(
          expect.stringMatching(/promote-owner/),
          expect.anything()
        );
      });

      it('points at `list-servers`/`delete-server` (never `promote-owner`) when ONLY the server row survives - zero users remain', async () => {
        const serverDeleteErr = new Error('server delete failed');
        const ports = makePorts({
          linkEmbyAccount: vi.fn().mockRejectedValue(new Error('link failed')),
          deleteServer: vi.fn().mockRejectedValue(serverDeleteErr),
        });

        await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

        expect(ports.logError).toHaveBeenCalledWith(
          expect.stringMatching(/list-servers/),
          expect.objectContaining({ err: serverDeleteErr })
        );
        expect(ports.logError).toHaveBeenCalledWith(
          expect.stringMatching(/delete-server/),
          expect.objectContaining({ err: serverDeleteErr })
        );
        expect(ports.logError).not.toHaveBeenCalledWith(
          expect.stringMatching(/promote-owner/),
          expect.anything()
        );
      });
    });
  });

  describe('secrets never appear in a thrown message', () => {
    it('never includes the api key or password in any EmbySetupError message across every failure path', async () => {
      const secretApiKey = 'super-secret-api-key-12345';
      const secretPassword = 'super-secret-password-67890';
      const input: EmbySetupInput = {
        ...BASE_INPUT,
        apiKey: secretApiKey,
        password: secretPassword,
      };

      const scenarios: Partial<EmbySetupPorts>[] = [
        { getClaimState: vi.fn().mockResolvedValue('owned') },
        {
          verifyServerAdmin: vi
            .fn()
            .mockResolvedValue({ success: false, code: 'INVALID_KEY', message: secretApiKey }),
        },
        { authenticate: vi.fn().mockResolvedValue(null) },
        { createOwnerUser: vi.fn().mockRejectedValue(new Error('boom')) },
      ];

      for (const overrides of scenarios) {
        const ports = makePorts(overrides);
        const error = await runEmbySetup(input, ports).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EmbySetupError);
        expect((error as Error).message).not.toContain(secretApiKey);
        expect((error as Error).message).not.toContain(secretPassword);
      }
    });
  });
});

describe('setup probe concurrency slots', () => {
  beforeEach(() => resetSetupProbeSlotsForTests());

  it(`allows up to MAX_CONCURRENT_SETUP_PROBES (${MAX_CONCURRENT_SETUP_PROBES}) concurrent slots`, () => {
    for (let i = 0; i < MAX_CONCURRENT_SETUP_PROBES; i++) {
      expect(acquireSetupProbeSlot()).toBe(true);
    }
    expect(acquireSetupProbeSlot()).toBe(false);
  });

  it('frees a slot on release, allowing another acquire', () => {
    for (let i = 0; i < MAX_CONCURRENT_SETUP_PROBES; i++) acquireSetupProbeSlot();
    expect(acquireSetupProbeSlot()).toBe(false);

    releaseSetupProbeSlot();
    expect(acquireSetupProbeSlot()).toBe(true);
  });

  it('never goes negative on an extra release', () => {
    releaseSetupProbeSlot();
    releaseSetupProbeSlot();
    for (let i = 0; i < MAX_CONCURRENT_SETUP_PROBES; i++) {
      expect(acquireSetupProbeSlot()).toBe(true);
    }
    expect(acquireSetupProbeSlot()).toBe(false);
  });
});

// ============================================================================
// CR-1 boundary test: drives the REAL /emby/setup endpoint end to end
// (real better-auth instance, real better-call APIError -> Response
// serialization) and reads the raw HTTP JSON body a browser would receive.
// better-call's APIError(status, body) writes `body` VERBATIM as the wire
// response (better-call/dist/to-response.mjs: `toResponse(data.body, ...)`),
// so `code` must be a top-level key of that 2nd arg - not nested under its
// own `body` key - or Login.tsx's `error.code` switch never matches and every
// setup error falls back to English server prose. This is the seam the two
// unit-mock suites (embySetupPlugin.test.ts's runEmbySetup tests above, and
// the client's own EmbySetupErrorCode fixtures) each individually pass
// without ever proving right: neither side round-trips a real HTTP response.
//
// Only getInstanceClaimState is stubbed (via the module mock above) so the
// INSTANCE_OWNED scenario is reachable without a live Postgres; the BUSY
// scenario below never even reaches that port (the concurrency-slot check in
// embySetupPlugin.ts runs before runEmbySetup), so it exercises the real
// authGuards module untouched.
// ============================================================================
describe('CR-1: /emby/setup error contract on the real wire', () => {
  const validSetupBody = {
    serverUrl: 'http://emby.local:8096',
    serverName: 'My Emby',
    apiKey: 'admin-api-key',
    username: 'owner',
    password: 'super-secret-password',
  };

  async function postSetup(auth: { handler: (req: Request) => Promise<Response> }) {
    const { betterAuthBasePath } = await import('../basePath.js');
    const req = new Request(`http://localhost${betterAuthBasePath()}${EMBY_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSetupBody),
    });
    return auth.handler(req);
  }

  beforeEach(async () => {
    resetSetupProbeSlotsForTests();
    // Explicit default so every test in this block is independent of
    // execution order - vitest's `restoreMocks` config resets `.mock.calls`
    // but a `vi.fn()` created inside a `vi.mock()` factory (not `vi.spyOn`)
    // is not guaranteed to fall back to a resolved-`undefined` no-op the way
    // a spy's original implementation would; observed leaking a
    // `mockResolvedValue('owned')` from an earlier test into this one.
    const { getInstanceClaimState } = await import('../authGuards.js');
    vi.mocked(getInstanceClaimState).mockResolvedValue('unclaimed');
  });

  afterEach(async () => {
    resetSetupProbeSlotsForTests();
    const { closeAuth } = await import('../auth.js');
    await closeAuth();
  });

  it('puts `code` at the TOP LEVEL of the JSON body for an EmbySetupError (INSTANCE_OWNED)', async () => {
    const { getInstanceClaimState } = await import('../authGuards.js');
    vi.mocked(getInstanceClaimState).mockResolvedValue('owned');

    const { getAuth } = await import('../auth.js');
    const auth = getAuth({ rateLimit: false });

    const res = await postSetup(auth);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(403);
    // The regression this guards: a nested `json.body.code` (and a top-level
    // `code` of undefined) is exactly what shipped before the CR-1 fix.
    expect(json.code).toBe('INSTANCE_OWNED');
    expect(json).not.toHaveProperty('body');
  });

  it('puts `code` at the TOP LEVEL of the JSON body for the concurrency-slot rejection (BUSY)', async () => {
    // Exhausts every slot before the request is sent, so the endpoint's OWN
    // `!acquireSetupProbeSlot()` guard throws before runEmbySetup/getInstanceClaimState
    // ever runs - this proves the 2nd throw site independent of the 1st.
    for (let i = 0; i < MAX_CONCURRENT_SETUP_PROBES; i++) {
      expect(acquireSetupProbeSlot()).toBe(true);
    }

    const { getAuth } = await import('../auth.js');
    const auth = getAuth({ rateLimit: false });

    const res = await postSetup(auth);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(json.code).toBe('BUSY');
    expect(json).not.toHaveProperty('body');
  });

  it('CR-6: puts `code` at the TOP LEVEL for the claim-code gate, which throws from auth.ts hooks.before, before embySetupPlugin.ts ever runs', async () => {
    const { initializeClaimCode, resetClaimCode } = await import('../../utils/claimCode.js');
    process.env.CLAIM_CODE = 'TEST-CODE-1234';
    initializeClaimCode();

    try {
      const { getAuth } = await import('../auth.js');
      const auth = getAuth({ rateLimit: false });

      // BASE_INPUT/validSetupBody carries no claimCode - this hook
      // (auth.ts's hooks.before, calling authGuards.ts's assertClaimCode)
      // throws directly to better-auth's router, entirely bypassing
      // embySetupPlugin.ts's own error-mapping catch block.
      const res = await postSetup(auth);
      const json = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(403);
      expect(json.code).toBe('CLAIM_CODE');
      expect(json).not.toHaveProperty('body');
    } finally {
      resetClaimCode();
      delete process.env.CLAIM_CODE;
    }
  });

  it('CR-10/IMP-11: an already-owned instance gets INSTANCE_OWNED even with every concurrency slot exhausted, never BUSY', async () => {
    const { getInstanceClaimState } = await import('../authGuards.js');
    vi.mocked(getInstanceClaimState).mockResolvedValue('owned');

    // Exhaust every slot BEFORE the request - if the endpoint acquired a
    // slot before checking claim state (the pre-fix order), this would
    // observe BUSY (503) instead of the real, instant INSTANCE_OWNED (403).
    for (let i = 0; i < MAX_CONCURRENT_SETUP_PROBES; i++) {
      expect(acquireSetupProbeSlot()).toBe(true);
    }

    const { getAuth } = await import('../auth.js');
    const auth = getAuth({ rateLimit: false });

    const res = await postSetup(auth);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(json.code).toBe('INSTANCE_OWNED');

    // The slots are untouched by this request - still exactly as exhausted
    // as this test left them, proving no slot was acquired for this path.
    expect(acquireSetupProbeSlot()).toBe(false);
  });
});
