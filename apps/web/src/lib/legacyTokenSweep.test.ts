import { describe, it, expect, beforeEach } from 'vitest';
import { tokenStorage } from '@/lib/api';
import { sweepLegacyTokens } from './legacyTokenSweep';

describe('sweepLegacyTokens', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes legacy access and refresh tokens', () => {
    tokenStorage.setTokens('access-123', 'refresh-456');

    sweepLegacyTokens();

    expect(tokenStorage.getAccessToken()).toBeNull();
    expect(tokenStorage.getRefreshToken()).toBeNull();
  });

  it('does not throw when no tokens are present', () => {
    expect(() => sweepLegacyTokens()).not.toThrow();
  });

  it('leaves unrelated localStorage keys untouched', () => {
    localStorage.setItem('tracearr-theme', 'dark');

    sweepLegacyTokens();

    expect(localStorage.getItem('tracearr-theme')).toBe('dark');
  });
});
