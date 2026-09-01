import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptConfig,
  encryptConfig,
  initDestinationCrypto,
  resetDestinationCryptoForTests,
} from '../notifications/destinationCrypto.js';

const HEX64 = 'a'.repeat(64);

describe('destinationCrypto', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetDestinationCryptoForTests();
    delete process.env.ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'test-jwt-secret';
  });
  afterEach(() => {
    process.env = { ...env };
    resetDestinationCryptoForTests();
  });

  it('round-trips under the derived key and prefixes the version', () => {
    initDestinationCrypto();
    const blob = encryptConfig({ webhookUrl: 'https://x', n: 1 });
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decryptConfig(blob)).toEqual({
      ok: true,
      config: { webhookUrl: 'https://x', n: 1 },
      rewrap: false,
    });
  });

  it('reports bad_key when a byte of a valid blob is flipped', () => {
    initDestinationCrypto();
    const blob = encryptConfig({ a: 1 });
    const raw = Buffer.from(blob.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    expect(decryptConfig(`v1:${raw.toString('base64')}`)).toEqual({ ok: false, reason: 'bad_key' });
  });

  it('uses a random iv per write', () => {
    initDestinationCrypto();
    expect(encryptConfig({ a: 1 })).not.toBe(encryptConfig({ a: 1 }));
  });

  it('reports bad_key under a different secret and malformed on garbage', () => {
    initDestinationCrypto();
    const blob = encryptConfig({ a: 1 });
    resetDestinationCryptoForTests();
    process.env.JWT_SECRET = 'another';
    initDestinationCrypto();
    expect(decryptConfig(blob)).toEqual({ ok: false, reason: 'bad_key' });
    expect(decryptConfig('v1:not-base64!!')).toEqual({ ok: false, reason: 'malformed' });
    expect(decryptConfig('v9:AAAA')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('prefers an explicit ENCRYPTION_KEY and still opens derived-key blobs, asking for a rewrap', () => {
    initDestinationCrypto();
    const derivedBlob = encryptConfig({ a: 1 });
    resetDestinationCryptoForTests();
    process.env.ENCRYPTION_KEY = HEX64;
    initDestinationCrypto();
    const explicitBlob = encryptConfig({ a: 2 });
    expect(decryptConfig(explicitBlob)).toEqual({ ok: true, config: { a: 2 }, rewrap: false });
    expect(decryptConfig(derivedBlob)).toEqual({ ok: true, config: { a: 1 }, rewrap: true });
  });

  it('fails boot on a malformed explicit key', () => {
    process.env.ENCRYPTION_KEY = 'not-hex';
    expect(() => initDestinationCrypto()).toThrow(/ENCRYPTION_KEY/);
    resetDestinationCryptoForTests();
    process.env.ENCRYPTION_KEY = 'ab'.repeat(31);
    expect(() => initDestinationCrypto()).toThrow(/64 hex/);
  });

  it('throws when neither key source exists', () => {
    delete process.env.JWT_SECRET;
    expect(() => initDestinationCrypto()).toThrow(/JWT_SECRET/);
  });
});
