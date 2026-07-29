import { describe, it, expect } from 'vitest';
import { resolveTrustProxy } from '../trustProxy.js';

describe('resolveTrustProxy', () => {
  it('returns false when unset', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('')).toBe(false);
  });

  it('returns false for the literal string "false"', () => {
    expect(resolveTrustProxy('false')).toBe(false);
  });

  it('keeps "true" working as the documented, discouraged any-hop fallback', () => {
    expect(resolveTrustProxy('true')).toBe(true);
  });

  it('parses a positive integer as a hop count, not a boolean', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy('2')).toBe(2);
  });

  it('rejects zero and negative hop counts as invalid (fails closed to false, never a one-entry IP list)', () => {
    expect(resolveTrustProxy('0')).toBe(false);
    expect(resolveTrustProxy('-1')).toBe(false);
  });

  it('parses a comma-separated proxy IP/CIDR list', () => {
    expect(resolveTrustProxy('10.0.0.5,192.168.1.0/24')).toEqual(['10.0.0.5', '192.168.1.0/24']);
  });

  it('trims whitespace in a proxy list', () => {
    expect(resolveTrustProxy(' 10.0.0.5 , 10.0.0.6 ')).toEqual(['10.0.0.5', '10.0.0.6']);
  });
});
