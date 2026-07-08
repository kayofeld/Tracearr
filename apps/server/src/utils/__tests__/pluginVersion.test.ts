import { describe, it, expect } from 'vitest';
import {
  parseDottedVersion,
  compareVersions,
  maxVersion,
  parseHelloPayload,
} from '../pluginVersion.js';

describe('parseDottedVersion', () => {
  it('parses 4-part and 3-part versions', () => {
    expect(parseDottedVersion('0.2.0.0')).toEqual([0, 2, 0, 0]);
    expect(parseDottedVersion('1.10.3')).toEqual([1, 10, 3]);
  });

  it('rejects garbage', () => {
    expect(parseDottedVersion('')).toBeNull();
    expect(parseDottedVersion('abc')).toBeNull();
    expect(parseDottedVersion('1.2.x')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0.0', '0.2.0.0')).toBe(1);
    expect(compareVersions('0.2.0.0', '0.10.0.0')).toBe(-1);
  });

  it('treats missing parts as zero', () => {
    expect(compareVersions('0.2.0', '0.2.0.0')).toBe(0);
  });

  it('equal versions compare 0', () => {
    expect(compareVersions('0.2.0.0', '0.2.0.0')).toBe(0);
  });
});

describe('maxVersion', () => {
  it('returns the numeric max regardless of order', () => {
    expect(maxVersion(['0.1.0.0', '0.10.0.0', '0.2.0.0'])).toBe('0.10.0.0');
  });

  it('ignores unparseable entries', () => {
    expect(maxVersion(['garbage', '0.2.0.0'])).toBe('0.2.0.0');
    expect(maxVersion(['garbage'])).toBeNull();
    expect(maxVersion([])).toBeNull();
  });
});

describe('parseHelloPayload', () => {
  it('parses a valid hello', () => {
    expect(parseHelloPayload('{"version":"0.2.0.0","server":"jellyfin"}')).toEqual({
      version: '0.2.0.0',
      server: 'jellyfin',
    });
  });

  it('returns null for malformed or incomplete payloads', () => {
    expect(parseHelloPayload('not json')).toBeNull();
    expect(parseHelloPayload('{"server":"emby"}')).toBeNull();
    expect(parseHelloPayload('{"version":42,"server":"emby"}')).toBeNull();
  });
});
