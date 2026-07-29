import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    isClaimCodeConfigured: vi.fn().mockReturnValue(false),
    resolveEmbyServer: vi.fn().mockResolvedValue(null),
    verifyServerAdmin: vi.fn().mockResolvedValue({ success: true }),
    authenticate: vi
      .fn()
      .mockResolvedValue({ id: 'emby-user-1', token: 'emby-token', isAdmin: true }),
    createOwnerUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    insertServer: vi
      .fn()
      .mockResolvedValue({ id: 'server-1', name: 'Emby', url: 'http://emby.local:8096' }),
    updateServerToken: vi.fn().mockResolvedValue(undefined),
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
      expect(ports.resolveEmbyServer).not.toHaveBeenCalled();
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
      expect(ports.createOwnerUser).not.toHaveBeenCalled();
    });
  });

  describe('the `ownerless-with-data` state', () => {
    it('refuses with INSTANCE_RECOVERY and logs the marker when no claim code is configured at all', async () => {
      const ports = makePorts({
        getClaimState: vi.fn().mockResolvedValue('ownerless-with-data'),
        isClaimCodeConfigured: vi.fn().mockReturnValue(false),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EmbySetupError);
      expect((error as EmbySetupError).code).toBe('INSTANCE_RECOVERY');
      expect(ports.resolveEmbyServer).not.toHaveBeenCalled();
      expect(ports.logError).toHaveBeenCalledWith(
        expect.stringContaining('OWNERLESS_INSTANCE_WITH_DATA')
      );
    });

    it('refuses with INSTANCE_RECOVERY when no Emby server row can be resolved', async () => {
      const ports = makePorts({
        getClaimState: vi.fn().mockResolvedValue('ownerless-with-data'),
        isClaimCodeConfigured: vi.fn().mockReturnValue(true),
        resolveEmbyServer: vi.fn().mockResolvedValue(null),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('INSTANCE_RECOVERY');
      expect(ports.verifyServerAdmin).not.toHaveBeenCalled();
    });

    it('refuses with INSTANCE_RECOVERY when server resolution is ambiguous (resolveEmbyServer throws)', async () => {
      const ports = makePorts({
        getClaimState: vi.fn().mockResolvedValue('ownerless-with-data'),
        isClaimCodeConfigured: vi.fn().mockReturnValue(true),
        resolveEmbyServer: vi.fn().mockRejectedValue(new Error('ambiguous')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);
      expect((error as EmbySetupError).code).toBe('INSTANCE_RECOVERY');
    });

    it('ignores the client-supplied serverUrl entirely and adopts the resolved row instead', async () => {
      const ports = makePorts({
        getClaimState: vi.fn().mockResolvedValue('ownerless-with-data'),
        isClaimCodeConfigured: vi.fn().mockReturnValue(true),
        resolveEmbyServer: vi
          .fn()
          .mockResolvedValue({
            id: 'server-9',
            name: 'Existing Emby',
            url: 'http://real-emby.local:8096',
          }),
      });

      const attackerInput: EmbySetupInput = {
        ...BASE_INPUT,
        serverUrl: 'http://attacker.example.com/',
      };

      const result = await runEmbySetup(attackerInput, ports);

      expect(ports.verifyServerAdmin).toHaveBeenCalledWith(
        attackerInput.apiKey,
        'http://real-emby.local:8096'
      );
      expect(ports.insertServer).not.toHaveBeenCalled();
      expect(ports.updateServerToken).toHaveBeenCalledWith('server-9', attackerInput.apiKey);
      expect(result.server).toEqual({
        id: 'server-9',
        name: 'Existing Emby',
        url: 'http://real-emby.local:8096',
      });
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
          .mockRejectedValue(
            new Error('duplicate key value violates unique constraint "users_single_owner"')
          ),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('INSTANCE_OWNED');
      expect((error as EmbySetupError).httpStatus).toBe(403);
      expect(ports.deleteServer).not.toHaveBeenCalled();
      expect(ports.deleteUser).not.toHaveBeenCalled();
      expect(ports.insertServer).not.toHaveBeenCalled();
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

    it('never adopts (never deletes) an EXISTING server row on failure in the ownerless-with-data branch', async () => {
      const ports = makePorts({
        getClaimState: vi.fn().mockResolvedValue('ownerless-with-data'),
        isClaimCodeConfigured: vi.fn().mockReturnValue(true),
        resolveEmbyServer: vi
          .fn()
          .mockResolvedValue({ id: 'server-9', name: 'Existing', url: 'http://real.local:8096' }),
        linkEmbyAccount: vi.fn().mockRejectedValue(new Error('link failed')),
      });

      const error = await runEmbySetup(BASE_INPUT, ports).catch((e: unknown) => e);

      expect((error as EmbySetupError).code).toBe('SETUP_FAILED');
      expect(ports.deleteServer).not.toHaveBeenCalled(); // adopted, never inserted by this attempt
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
