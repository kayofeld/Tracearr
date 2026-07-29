import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { createLogger, redactLogContext } from '../logger.js';

describe('redactLogContext', () => {
  it('drops `params` entirely, even when it contains a secret value', () => {
    const result = redactLogContext({ params: ['owner', 'super-secret-api-key'] });
    expect(result).not.toHaveProperty('params');
  });

  it('masks sensitive key names anywhere in the context, case-insensitively', () => {
    const result = redactLogContext({
      apiKey: 'super-secret-api-key',
      Password: 'super-secret-password',
      accessToken: 'emby-access-token',
      nested: { token: 'nested-token', ok: 'fine' },
    });

    expect(result).toEqual({
      apiKey: '[REDACTED]',
      Password: '[REDACTED]',
      accessToken: '[REDACTED]',
      nested: { token: '[REDACTED]', ok: 'fine' },
    });
  });

  it('redacts inside arrays too', () => {
    const result = redactLogContext({ list: [{ password: 'secret1' }, { password: 'secret2' }] });
    expect(result).toEqual({ list: [{ password: '[REDACTED]' }, { password: '[REDACTED]' }] });
  });

  it('never throws on a circular structure, and marks the cycle', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj.self = obj;
    expect(() => redactLogContext({ err: obj })).not.toThrow();
    const result = redactLogContext({ err: obj }) as { err: { self: unknown } };
    expect(result.err.self).toBe('[CIRCULAR]');
  });

  it('SEC-10: drops the REAL DrizzleQueryError.params (which can carry the Emby API key/password positionally), never just a bare Error shape', () => {
    const secretApiKey = 'super-secret-api-key-12345';
    const cause = new Error('duplicate key value violates unique constraint "servers_single_emby"');
    const err = new DrizzleQueryError(
      'insert into "servers" ("name","url","token") values ($1,$2,$3)',
      ['Emby', 'http://emby.local:8096', secretApiKey],
      cause
    );

    const result = redactLogContext({ err }) as { err: Record<string, unknown> };

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretApiKey);
    expect(result.err).not.toHaveProperty('params');
    // Pins the regression this test caught during implementation: dropping
    // only the `.params` PROPERTY is not enough - DrizzleQueryError's own
    // `.message` bakes the same params into its text
    // (`Failed query: <sql>\nparams: <params>`), so the message itself must
    // be rebuilt from the query alone.
    expect(result.err.message).not.toContain(secretApiKey);
    expect(result.err.message).toContain('insert into "servers"');
    // The query text and cause are still present - only the secret-bearing
    // positional params are gone, not the whole diagnostic.
    expect(result.err.query).toContain('insert into "servers"');
    expect(result.err.cause).toMatchObject({
      message: expect.stringContaining('servers_single_emby'),
    });
  });

  it('NEW-01: strips the same params tail from a BARE STRING value, not only from inside an Error object - the old `{ cause: err.message }` call-site shape that bypassed the Error-shape rebuild above', () => {
    const secretAccessToken = 'super-secret-emby-access-token-98765';
    const err = new DrizzleQueryError(
      'insert into "auth_accounts" ("user_id","access_token") values ($1,$2)',
      ['user-1', secretAccessToken],
      new Error('some db failure')
    );

    // Simulates the exact leak this fix closes: a call site logging the
    // Error's `.message` STRING directly (as embySetupPlugin.ts's compensation
    // log used to) rather than the Error object itself.
    const result = redactLogContext({ cause: err.message }) as { cause: string };

    expect(result.cause).not.toContain(secretAccessToken);
    expect(result.cause).toContain('insert into "auth_accounts"');
  });

  it('leaves a context with no sensitive shape untouched (message, request id, claim state)', () => {
    const result = redactLogContext({ requestId: 'req-1', claimState: 'unclaimed', attempt: 2 });
    expect(result).toEqual({ requestId: 'req-1', claimState: 'unclaimed', attempt: 2 });
  });

  it('passes through undefined unchanged', () => {
    expect(redactLogContext(undefined)).toBeUndefined();
  });
});

describe('createLogger redaction wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never lets console.error see a raw apiKey/password field', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger('test');

    logger.error('setup failed', { apiKey: 'super-secret-api-key', password: 'super-secret-pw' });

    const loggedArgs = spy.mock.calls[0];
    const serialized = JSON.stringify(loggedArgs);
    expect(serialized).not.toContain('super-secret-api-key');
    expect(serialized).not.toContain('super-secret-pw');
  });
});
