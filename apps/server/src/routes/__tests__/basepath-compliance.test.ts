/**
 * BASE_PATH compliance tests — CI guardrails
 *
 * Static analysis tests that scan source files for patterns that would break
 * when BASE_PATH is set. These catch regressions before they ship.
 *
 * No DB, Redis, or Fastify required — just file reads.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../../../..');
const WEB_SRC = resolve(PROJECT_ROOT, 'apps/web/src');
const SERVER_SRC = resolve(PROJECT_ROOT, 'apps/server/src');

/** Recursively collect all .ts/.tsx files under a directory */
function collectFiles(dir: string, ext: string[] = ['.ts', '.tsx']): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
      files.push(...collectFiles(full, ext));
    } else if (entry.isFile() && ext.some((e) => entry.name.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

// ==========================================================================
// Frontend: no hardcoded fetch('/...') calls
// ==========================================================================
describe('frontend: no hardcoded fetch URLs', () => {
  // Matches fetch('/anything') or fetch("/anything") — direct fetch calls that
  // bypass the API client and don't use BASE_PATH. This includes window.fetch(...)
  // and any other object-qualified bare fetch, since those still hit the origin
  // root and skip BASE_PATH.
  // Allowed: fetch(`${BASE_PATH}/...`) or fetch(`${someVar}/...`), and
  // authClient.$fetch('/...') specifically, which resolves against a
  // BASE_PATH-aware baseURL (the lookbehind only skips the $fetch method name).
  const HARDCODED_FETCH = /(?<!\$)fetch\(\s*['"]\/[^'"]*/g;

  const files = collectFiles(WEB_SRC);

  it('has frontend source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no fetch() calls with hardcoded absolute paths', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (HARDCODED_FETCH.test(line)) {
          const rel = relative(PROJECT_ROOT, file);
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        // Reset regex lastIndex since we use /g flag
        HARDCODED_FETCH.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });

  it('flags a genuine bare fetch() call with a hardcoded path', () => {
    const line = `  const res = await fetch('/api/v1/servers');`;
    expect(HARDCODED_FETCH.test(line)).toBe(true);
    HARDCODED_FETCH.lastIndex = 0;
  });

  it('flags a window.fetch() call with a hardcoded path', () => {
    const line = `  const res = await window.fetch('/api/v1/servers');`;
    expect(HARDCODED_FETCH.test(line)).toBe(true);
    HARDCODED_FETCH.lastIndex = 0;
  });

  it('still exempts authClient.$fetch() calls', () => {
    const line = `  const { error } = await authClient.$fetch('/sign-up/email');`;
    expect(HARDCODED_FETCH.test(line)).toBe(false);
    HARDCODED_FETCH.lastIndex = 0;
  });
});

// ==========================================================================
// Frontend: notification agent imagePaths use BASE_URL
// ==========================================================================
describe('frontend: notification agent imagePaths use BASE_URL', () => {
  const agentConfigPath = resolve(
    WEB_SRC,
    'components/settings/notification-agents/agent-config.ts'
  );

  it('agent-config.ts exists', () => {
    expect(() => readFileSync(agentConfigPath, 'utf-8')).not.toThrow();
  });

  it('all imagePath values use BASE_URL prefix', () => {
    const content = readFileSync(agentConfigPath, 'utf-8');

    // Extract all imagePath assignments
    const imagePathPattern = /imagePath:\s*(.+),/g;
    const matches = [...content.matchAll(imagePathPattern)];

    // There should be at least a few agents with images
    expect(matches.length).toBeGreaterThanOrEqual(3);

    const violations: string[] = [];
    for (const match of matches) {
      const value = match[1]!.trim();
      // Must be a template literal using BASE_URL
      if (!value.includes('BASE_URL')) {
        violations.push(`imagePath value does not use BASE_URL: ${value}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('imports BASE_URL from basePath module', () => {
    const content = readFileSync(agentConfigPath, 'utf-8');
    expect(content).toMatch(/import\s*\{[^}]*BASE_URL[^}]*\}\s*from\s*['"]@\/lib\/basePath['"]/);
  });
});

// ==========================================================================
// Frontend: BASE_URL usage must not add leading slash (causes // bug)
// ==========================================================================
describe('frontend: BASE_URL paths must not start with /', () => {
  // BASE_URL already ends with / (e.g., "/" or "/tracearr/")
  // Adding another / creates protocol-relative URLs like "//api/..."
  // Pattern: ${BASE_URL}/ where the / comes after the closing brace
  const DOUBLE_SLASH_PATTERN = /\$\{BASE_URL\}\//g;

  const files = collectFiles(WEB_SRC);

  it('no ${BASE_URL}/ patterns (path should not start with /)', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (DOUBLE_SLASH_PATTERN.test(line)) {
          const rel = relative(PROJECT_ROOT, file);
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        DOUBLE_SLASH_PATTERN.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });
});

// ==========================================================================
// Frontend: no hardcoded src="/..." attributes in JSX
// ==========================================================================
describe('frontend: no hardcoded src attributes for local assets', () => {
  // Matches src="/anything" or src='/anything' — hardcoded absolute paths in
  // JSX <img>, <source>, <video>, etc. that don't go through BASE_URL.
  // Does NOT match src={...} (dynamic), src="https://..." or src="http://..."
  const HARDCODED_SRC = /\bsrc=["']\/(?!\/)[^"']*/g;

  const files = collectFiles(WEB_SRC);

  it('no src attributes with hardcoded absolute paths', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (HARDCODED_SRC.test(line)) {
          const rel = relative(PROJECT_ROOT, file);
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        HARDCODED_SRC.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });
});

// ==========================================================================
// Server: no hardcoded redirect paths (outside of basePath-aware code)
// ==========================================================================
describe('server: redirects use BASE_PATH', () => {
  it('all reply.redirect() calls reference BASE_PATH or basePath variable', () => {
    const files = collectFiles(SERVER_SRC);
    const violations: string[] = [];

    // Match reply.redirect('...') with a hardcoded string
    const HARDCODED_REDIRECT = /reply\.redirect\(\s*['"]\/[^'"]*['"]\s*\)/g;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (HARDCODED_REDIRECT.test(line)) {
          const rel = relative(PROJECT_ROOT, file);
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        HARDCODED_REDIRECT.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });
});
