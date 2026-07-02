import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/userService.js', () => ({
  getOwnerUser: vi.fn(),
}));
vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(),
  validateClaimCode: vi.fn(),
}));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

import { getOwnerUser } from '../../services/userService.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import { assertSignupAllowed, assertClaimCode, assertUserCanLogin } from '../authGuards.js';
import { db } from '../../db/client.js';

function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

describe('assertSignupAllowed', () => {
  it('allows signup when no owner exists', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    await expect(assertSignupAllowed()).resolves.toBeUndefined();
  });

  it('rejects signup when an owner exists', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'u1', role: 'owner' } as never);
    await expect(assertSignupAllowed()).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });
});

describe('assertClaimCode', () => {
  beforeEach(() => vi.mocked(isClaimCodeEnabled).mockReturnValue(true));

  it('rejects a missing claim code when claim codes are enabled', () => {
    expect(() => assertClaimCode(undefined)).toThrowError();
  });

  it('rejects an invalid claim code', () => {
    vi.mocked(validateClaimCode).mockReturnValue(false);
    expect(() => assertClaimCode('bad')).toThrowError();
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

describe('assertUserCanLogin', () => {
  it('allows role owner', async () => {
    mockDbSelectLimit([{ role: 'owner' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
  });

  it('allows role admin', async () => {
    mockDbSelectLimit([{ role: 'admin' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
  });

  it('allows role viewer', async () => {
    mockDbSelectLimit([{ role: 'viewer' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
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
