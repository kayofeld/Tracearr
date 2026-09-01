import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const DERIVATION_INFO = 'tracearr-destinations-key-v1';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Keys {
  primary: Buffer;
  /** the other candidate: derived when an explicit key is primary, so older rows still open and get rewrapped */
  secondary: Buffer | null;
  source: 'ENCRYPTION_KEY' | 'JWT_SECRET';
}

let keys: Keys | null = null;

function derived(): Buffer | null {
  const jwt = process.env.JWT_SECRET;
  if (!jwt) return null;
  return Buffer.from(hkdfSync('sha256', jwt, '', DERIVATION_INFO, 32));
}

/** Explicit key wins and must be well-formed; otherwise the key derives from JWT_SECRET so upgrades need no new env var. */
export function initDestinationCrypto(): Keys['source'] {
  if (keys) return keys.source;
  const explicit = process.env.ENCRYPTION_KEY;
  const fromJwt = derived();
  if (explicit) {
    if (!/^[0-9a-f]{64}$/i.test(explicit)) {
      throw new Error('ENCRYPTION_KEY is set but is not 64 hex characters; fix or unset it');
    }
    keys = { primary: Buffer.from(explicit, 'hex'), secondary: fromJwt, source: 'ENCRYPTION_KEY' };
    return keys.source;
  }
  if (!fromJwt) throw new Error('JWT_SECRET is required to derive the destinations encryption key');
  keys = { primary: fromJwt, secondary: null, source: 'JWT_SECRET' };
  return keys.source;
}

function requireKeys(): Keys {
  if (!keys) throw new Error('initDestinationCrypto has not been called');
  return keys;
}

export function encryptConfig(config: Record<string, unknown>): string {
  const { primary } = requireKeys();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', primary, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

export type DecryptResult =
  | { ok: true; config: Record<string, unknown>; rewrap: boolean }
  | { ok: false; reason: 'bad_key' | 'malformed' };

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Record<string, unknown> | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decryptConfig(blob: string): DecryptResult {
  const { primary, secondary } = requireKeys();
  const sep = blob.indexOf(':');
  if (sep < 0 || blob.slice(0, sep) !== VERSION) return { ok: false, reason: 'malformed' };
  const encoded = blob.slice(sep + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { ok: false, reason: 'malformed' };
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) return { ok: false, reason: 'malformed' };
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const withPrimary = open(primary, iv, tag, ct);
  if (withPrimary) return { ok: true, config: withPrimary, rewrap: false };
  if (secondary) {
    const withSecondary = open(secondary, iv, tag, ct);
    if (withSecondary) return { ok: true, config: withSecondary, rewrap: true };
  }
  return { ok: false, reason: 'bad_key' };
}

export function resetDestinationCryptoForTests(): void {
  keys = null;
}
