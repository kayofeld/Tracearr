import type { TemplateEnvelope } from './templates.js';

export const SHARE_CODE_PREFIX = 'tracearr1.';

/** How deep a shared payload may nest, whether it arrived as a code or as JSON. */
const SHARE_MAX_DEPTH = 32;

const DEFAULT_LIMITS = { maxCode: 65536, maxOut: 1048576, maxDepth: SHARE_MAX_DEPTH };

export type ShareCodeReason = 'prefix' | 'too_long' | 'incomplete' | 'too_deep' | 'invalid_json';

export class ShareCodeError extends Error {
  constructor(readonly reason: ShareCodeReason) {
    super(`share code rejected: ${reason}`);
    this.name = 'ShareCodeError';
  }
}

/**
 * JSON.stringify with object keys sorted and undefined dropped: payloads that
 * differ only in key order serialize identically, so they fingerprint the same.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hex sha256 over the canonical form; the hash itself is injected so shared stays platform-neutral. */
export function fingerprintOf(
  parts: { inputs: unknown; definition: unknown },
  sha256Hex: (text: string) => string
): string {
  return sha256Hex(canonicalJson({ inputs: parts.inputs, definition: parts.definition }));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUES = new Map<string, number>();
for (let index = 0; index < ALPHABET.length; index += 1) {
  VALUES.set(ALPHABET.charAt(index), index);
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET.charAt(first >> 2);
    out += ALPHABET.charAt(((first & 0b11) << 4) | ((second ?? 0) >> 4));
    if (second === undefined) break;
    out += ALPHABET.charAt(((second & 0b1111) << 2) | ((third ?? 0) >> 6));
    if (third === undefined) break;
    out += ALPHABET.charAt(third & 0b111111);
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new ShareCodeError('incomplete');
  const bytes = new Uint8Array((text.length * 3) >> 2);
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = VALUES.get(char);
    if (value === undefined) throw new ShareCodeError('incomplete');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes[written] = (buffer >> bits) & 0xff;
    written += 1;
  }
  return bytes.subarray(0, written);
}

export function encodeShareCode(
  envelope: TemplateEnvelope,
  deflateRaw: (bytes: Uint8Array) => Uint8Array
): string {
  const payload = new TextEncoder().encode(canonicalJson(envelope));
  return SHARE_CODE_PREFIX + toBase64Url(deflateRaw(payload));
}

/** Throws `too_deep` past the cap; a pasted envelope needs this without a code to decode. */
export function assertShareDepth(value: unknown, remaining: number = SHARE_MAX_DEPTH): void {
  if (remaining < 0) throw new ShareCodeError('too_deep');
  if (Array.isArray(value)) {
    for (const item of value) assertShareDepth(item, remaining - 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertShareDepth(item, remaining - 1);
    }
  }
}

/** Returns whatever the code carried; the caller decides whether it is an envelope. */
export function decodeShareCode(
  code: string,
  inflateRaw: (bytes: Uint8Array, maxOut: number) => Uint8Array,
  limits: { maxCode: number; maxOut: number; maxDepth: number } = DEFAULT_LIMITS
): unknown {
  if (code.length > limits.maxCode) throw new ShareCodeError('too_long');
  if (!code.startsWith(SHARE_CODE_PREFIX)) throw new ShareCodeError('prefix');
  const bytes = fromBase64Url(code.slice(SHARE_CODE_PREFIX.length));
  let json: string;
  try {
    json = new TextDecoder().decode(inflateRaw(bytes, limits.maxOut));
  } catch {
    throw new ShareCodeError('incomplete');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ShareCodeError('invalid_json');
  }
  assertShareDepth(value, limits.maxDepth);
  return value;
}
