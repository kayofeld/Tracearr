/**
 * The zlib half of the share-code format. Shared owns the framing and the caps
 * and takes the compressor as an argument, so node's lives here.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { decodeShareCode, encodeShareCode, type TemplateEnvelope } from '@tracearr/shared';

/** Returns whatever the code carried; the caller decides whether it is an envelope. */
export function decodeTemplateCode(code: string): unknown {
  return decodeShareCode(
    code,
    (bytes, maxOut) => new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxOut }))
  );
}

export function encodeTemplateCode(envelope: TemplateEnvelope): string {
  return encodeShareCode(envelope, (bytes) => new Uint8Array(deflateRawSync(bytes)));
}
