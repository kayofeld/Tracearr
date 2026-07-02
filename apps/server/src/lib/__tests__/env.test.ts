import { describe, it, expect, afterEach } from 'vitest';
import { requireBetterAuthSecret } from '../env.js';

describe('requireBetterAuthSecret', () => {
  const original = process.env.BETTER_AUTH_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = original;
  });

  it('returns the secret when set', () => {
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(32);
    expect(requireBetterAuthSecret()).toBe('a'.repeat(32));
  });

  it('throws when unset', () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => requireBetterAuthSecret()).toThrow('BETTER_AUTH_SECRET');
  });
});
