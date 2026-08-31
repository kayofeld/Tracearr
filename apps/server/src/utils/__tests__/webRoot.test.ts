import { describe, it, expect } from 'vitest';
import { resolveWebAsset } from '../webRoot.js';

describe('resolveWebAsset', () => {
  const root = '/srv/tracearr/apps/web/dist';

  it('returns the root-relative path for a normal asset', () => {
    expect(resolveWebAsset(root, '/assets/index-abc123.js')).toBe('assets/index-abc123.js');
  });

  it('returns the root-relative path for a nested asset', () => {
    expect(resolveWebAsset(root, '/assets/fonts/inter.woff2')).toBe('assets/fonts/inter.woff2');
  });

  it('rejects dot-segment escape', () => {
    expect(resolveWebAsset(root, '/../../../../etc/passwd.txt')).toBeNull();
  });

  it('rejects an absolute path smuggled through a double slash', () => {
    expect(resolveWebAsset(root, '//etc/hosts.txt')).toBeNull();
  });

  it('rejects a traversal landing on a sibling of the root', () => {
    expect(resolveWebAsset(root, '/../dist-backup/secret.env')).toBeNull();
  });

  it('rejects a sibling whose name merely extends the root', () => {
    expect(resolveWebAsset(root, '/../dist-evil/app.js')).toBeNull();
  });

  it('rejects a path that is not absolute', () => {
    expect(resolveWebAsset(root, 'assets/app.js')).toBeNull();
  });

  it('normalises an interior dot-segment that stays inside the root', () => {
    expect(resolveWebAsset(root, '/assets/../assets/app.js')).toBe('assets/app.js');
  });

  it('never returns a path that climbs out of the root', () => {
    for (const attempt of [
      '/../etc/passwd.txt',
      '/..%2f..%2fetc/passwd.txt',
      '/./../../etc/shadow.txt',
      '//../etc/passwd.txt',
    ]) {
      const result = resolveWebAsset(root, attempt);
      if (result !== null) expect(result.startsWith('..')).toBe(false);
    }
  });
});
