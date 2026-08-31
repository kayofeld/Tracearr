import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(),
  validateClaimCode: vi.fn(),
}));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import {
  assertSignupAllowed,
  assertClaimCode,
  assertUserCanLogin,
  assertOAuthSignupClaimCode,
  getInstanceClaimState,
} from '../authGuards.js';
import { db } from '../../db/client.js';

/**
 * getInstanceClaimState() issues four `db.select(...).from(...).where...limit(1)`
 * calls in parallel (owner row, any user row, any auth_accounts row, any
 * servers row - two of those omit `.where`). Each mocked chain call queues
 * the next configured result in call order, mirroring the four
 * Promise.all-issued queries in authGuards.ts.
 */
function mockClaimStateQueries(results: {
  owner?: unknown[];
  anyUser?: unknown[];
  anyAccount?: unknown[];
  anyServer?: unknown[];
}) {
  const queue = [
    results.owner ?? [],
    results.anyUser ?? [],
    results.anyAccount ?? [],
    results.anyServer ?? [],
  ];
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const result = queue[call] ?? [];
    call += 1;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(result),
    };
    return chain as never;
  });
}

/** Single-chain mock for assertUserCanLogin's one select. */
function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

describe('getInstanceClaimState', () => {
  it('returns "owned" when an owner row exists, regardless of the other three', async () => {
    mockClaimStateQueries({ owner: [{ id: 'u1' }], anyUser: [{ id: 'u1' }] });
    await expect(getInstanceClaimState()).resolves.toBe('owned');
  });

  it('returns "unclaimed" when there is no owner and no users/accounts/servers at all', async () => {
    mockClaimStateQueries({});
    await expect(getInstanceClaimState()).resolves.toBe('unclaimed');
  });

  it('returns "ownerless-with-data" when only a users row exists (no owner)', async () => {
    mockClaimStateQueries({ anyUser: [{ id: 'member-1' }] });
    await expect(getInstanceClaimState()).resolves.toBe('ownerless-with-data');
  });

  it('returns "ownerless-with-data" when only an auth_accounts row exists', async () => {
    mockClaimStateQueries({ anyAccount: [{ id: 'acct-1' }] });
    await expect(getInstanceClaimState()).resolves.toBe('ownerless-with-data');
  });

  it('returns "ownerless-with-data" when only a servers row exists', async () => {
    mockClaimStateQueries({ anyServer: [{ id: 'srv-1' }] });
    await expect(getInstanceClaimState()).resolves.toBe('ownerless-with-data');
  });
});

describe('assertSignupAllowed', () => {
  it('allows signup when the instance is unclaimed', async () => {
    mockClaimStateQueries({});
    await expect(assertSignupAllowed()).resolves.toBeUndefined();
  });

  it('rejects signup when an owner exists', async () => {
    mockClaimStateQueries({ owner: [{ id: 'u1' }] });
    await expect(assertSignupAllowed()).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('rejects signup when the instance is ownerless-with-data, with the CLI recovery message', async () => {
    mockClaimStateQueries({ anyServer: [{ id: 'srv-1' }] });
    await expect(assertSignupAllowed()).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { message: expect.stringMatching(/promote-owner/) },
    });
  });
});

describe('assertClaimCode', () => {
  beforeEach(() => vi.mocked(isClaimCodeEnabled).mockReturnValue(true));

  it('rejects a missing claim code when claim codes are enabled', () => {
    expect(() => assertClaimCode(undefined)).toThrow();
  });

  it('rejects an invalid claim code', () => {
    vi.mocked(validateClaimCode).mockReturnValue(false);
    expect(() => assertClaimCode('bad')).toThrow();
  });

  it('accepts a valid claim code', () => {
    vi.mocked(validateClaimCode).mockReturnValue(true);
    expect(() => assertClaimCode('good')).not.toThrow();
  });

  it('is a no-op when claim codes are disabled', () => {
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    expect(() => assertClaimCode(undefined)).not.toThrow();
  });
});

describe('assertOAuthSignupClaimCode', () => {
  it('is a no-op when an owner already exists, regardless of the code', async () => {
    mockClaimStateQueries({ owner: [{ id: 'u1' }] });
    await expect(assertOAuthSignupClaimCode(undefined)).resolves.toBeUndefined();
    expect(isClaimCodeEnabled).not.toHaveBeenCalled();
  });

  it('rejects an unclaimed instance with no claim code when claim codes are enabled', async () => {
    mockClaimStateQueries({});
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    await expect(assertOAuthSignupClaimCode(undefined)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('rejects an unclaimed instance with an invalid claim code', async () => {
    mockClaimStateQueries({});
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    vi.mocked(validateClaimCode).mockReturnValue(false);
    await expect(assertOAuthSignupClaimCode('wrong')).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('allows an unclaimed instance with a valid claim code', async () => {
    mockClaimStateQueries({});
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    vi.mocked(validateClaimCode).mockReturnValue(true);
    await expect(assertOAuthSignupClaimCode('right')).resolves.toBeUndefined();
  });

  it('allows an unclaimed instance with no code when claim codes are disabled', async () => {
    mockClaimStateQueries({});
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    await expect(assertOAuthSignupClaimCode(undefined)).resolves.toBeUndefined();
  });

  it('rejects an ownerless-with-data instance outright, never reaching the claim-code check', async () => {
    mockClaimStateQueries({ anyServer: [{ id: 'srv-1' }] });
    await expect(assertOAuthSignupClaimCode('any-code')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { message: expect.stringMatching(/promote-owner/) },
    });
    expect(isClaimCodeEnabled).not.toHaveBeenCalled();
  });
});

describe('assertUserCanLogin', () => {
  it('allows role owner', async () => {
    mockDbSelectLimit([{ role: 'owner' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
  });

  it('allows role admin', async () => {
    mockDbSelectLimit([{ role: 'admin' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
  });

  it('throws for role viewer', async () => {
    mockDbSelectLimit([{ role: 'viewer' }]);
    await expect(assertUserCanLogin('u1')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('throws for role member', async () => {
    mockDbSelectLimit([{ role: 'member' }]);
    await expect(assertUserCanLogin('u1')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('throws for role disabled', async () => {
    mockDbSelectLimit([{ role: 'disabled' }]);
    await expect(assertUserCanLogin('u1')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('throws for role pending', async () => {
    mockDbSelectLimit([{ role: 'pending' }]);
    await expect(assertUserCanLogin('u1')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('throws when the user row is missing', async () => {
    mockDbSelectLimit([]);
    await expect(assertUserCanLogin('deleted-user')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('propagates a db error (fails closed)', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('connection lost');
    });
    await expect(assertUserCanLogin('u1')).rejects.toThrow('connection lost');
  });
});
