import { describe, it, expect } from 'vitest';
import { resolveSameOrigin } from '../imageProxy.js';

describe('resolveSameOrigin (image-proxy SSRF / token-leak guard)', () => {
  const server = 'http://plex.local:32400';

  it('allows a normal relative image path', () => {
    const u = resolveSameOrigin(server, '/library/metadata/123/thumb/456');
    expect(u.origin).toBe('http://plex.local:32400');
    expect(u.pathname).toBe('/library/metadata/123/thumb/456');
  });

  it('preserves a reverse-proxy base path (does not drop /jellyfin)', () => {
    const u = resolveSameOrigin('https://host.example/jellyfin', '/Items/x/Images/Primary');
    expect(u.href).toBe('https://host.example/jellyfin/Items/x/Images/Primary');
  });

  it('keeps an existing query on the path', () => {
    const u = resolveSameOrigin(server, '/img?tag=abc');
    expect(u.searchParams.get('tag')).toBe('abc');
  });

  it('BLOCKS the userinfo host-hijack that would exfiltrate the token', () => {
    // "@evil.com/x" parses to host evil.com — must be rejected.
    expect(() => resolveSameOrigin(server, '@evil.com/x')).toThrow(/escapes server origin/);
  });

  it('blocks an absolute off-origin URL', () => {
    expect(() => resolveSameOrigin(server, 'http://evil.com/x')).toThrow();
  });

  it('treats a protocol-relative path as on-origin (harmless), never a host swap', () => {
    // "//evil.com/x" concatenated becomes http://plex.local:32400//evil.com/x —
    // host stays plex.local, path is //evil.com/x. Allowed (no token leak).
    const u = resolveSameOrigin(server, '//evil.com/x');
    expect(u.host).toBe('plex.local:32400');
  });

  it('appending the token cannot reach an off-origin host', () => {
    // End-to-end of the guard: even with the token set, origin is locked.
    const u = resolveSameOrigin(server, '/thumb');
    u.searchParams.set('X-Plex-Token', 'SECRET');
    expect(u.origin).toBe('http://plex.local:32400');
    expect(u.href).toContain('X-Plex-Token=SECRET');
  });
});
