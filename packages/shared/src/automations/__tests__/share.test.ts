import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SHARE_CODE_PREFIX,
  ShareCodeError,
  canonicalJson,
  decodeShareCode,
  encodeShareCode,
} from '../index.js';
import type { TemplateEnvelope } from '../index.js';

const deflateRaw = (bytes: Uint8Array) => new Uint8Array(deflateRawSync(bytes));
const inflateRaw = (bytes: Uint8Array, maxOut: number) =>
  new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxOut }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const envelope: TemplateEnvelope = {
  schemaVersion: 1,
  slug: 'stream-started',
  name: 'Stream started',
  description: 'Notify a destination whenever playback begins',
  group: 'notifications',
  kind: 'notification',
  minServerVersion: '2.2.0',
  inputs: [{ key: 'to', kind: 'destinations', label: 'Send to', required: true }],
  definition: {
    kind: 'notification',
    triggers: [{ id: id(1), type: 'session.started', enabled: true }],
    conditions: { groups: [] },
    actions: { actions: [{ id: id(2), type: 'send', to: { $input: 'to' } }] },
    scope: {},
  },
  fingerprint: 'a'.repeat(64),
};

describe('canonicalJson', () => {
  it('sorts keys, keeps array order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [3, 2], c: undefined })).toBe('{"a":[3,2],"b":1}');
  });
});

describe('share codes', () => {
  it('round-trips an envelope', () => {
    const code = encodeShareCode(envelope, deflateRaw);
    expect(code.startsWith(SHARE_CODE_PREFIX)).toBe(true);
    expect(decodeShareCode(code, inflateRaw)).toEqual(envelope);
  });

  it('rejects a truncated code', () => {
    const code = encodeShareCode(envelope, deflateRaw);
    expect(() => decodeShareCode(code.slice(0, code.length - 12), inflateRaw)).toThrow(
      ShareCodeError
    );
    try {
      decodeShareCode(code.slice(0, code.length - 12), inflateRaw);
    } catch (error) {
      expect((error as ShareCodeError).reason).toBe('incomplete');
    }
  });

  it('rejects an oversized code before inflating', () => {
    let calls = 0;
    const counted = (bytes: Uint8Array, maxOut: number) => {
      calls += 1;
      return inflateRaw(bytes, maxOut);
    };
    const code = SHARE_CODE_PREFIX + 'A'.repeat(65_537);
    try {
      decodeShareCode(code, counted);
      expect.unreachable('oversized code should throw');
    } catch (error) {
      expect((error as ShareCodeError).reason).toBe('too_long');
    }
    expect(calls).toBe(0);
  });

  it('rejects a small code that inflates past the output cap', () => {
    const bomb = { ...envelope, description: 'x'.repeat(2_000_000) };
    const code = encodeShareCode(bomb, deflateRaw);
    expect(code.length).toBeLessThan(65_536);
    try {
      decodeShareCode(code, inflateRaw);
      expect.unreachable('a compression bomb should throw');
    } catch (error) {
      expect((error as ShareCodeError).reason).toBe('incomplete');
    }
  });

  it('rejects a code with the wrong prefix', () => {
    const code = encodeShareCode(envelope, deflateRaw);
    try {
      decodeShareCode(code.replace(SHARE_CODE_PREFIX, 'tracearr2.'), inflateRaw);
      expect.unreachable('wrong prefix should throw');
    } catch (error) {
      expect((error as ShareCodeError).reason).toBe('prefix');
    }
  });

  it('rejects a payload nested past the depth limit', () => {
    let nested: unknown = 1;
    for (let level = 0; level < 40; level += 1) nested = [nested];
    const deep = encodeShareCode(nested as TemplateEnvelope, deflateRaw);
    try {
      decodeShareCode(deep, inflateRaw);
      expect.unreachable('deep payload should throw');
    } catch (error) {
      expect((error as ShareCodeError).reason).toBe('too_deep');
    }
  });
});
