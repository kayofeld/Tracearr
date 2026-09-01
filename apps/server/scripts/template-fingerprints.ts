#!/usr/bin/env tsx
/**
 * Validates every bundled template envelope and rewrites its fingerprint in place.
 * The seeder compares fingerprints to decide whether a builtin gained a version.
 *
 * Usage: pnpm templates:fingerprint
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fingerprintOf, templateEnvelopeSchema } from '@tracearr/shared';
import { firstIssueMessage } from '../src/utils/zod.js';

const dir = resolve(import.meta.dirname, '../src/services/automations/templates/builtin');
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const files = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .sort();

let rewritten = 0;
for (const file of files) {
  const path = resolve(dir, file);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const parsed = templateEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${firstIssueMessage(parsed.error)}`);

  const fingerprint = fingerprintOf(parsed.data, sha256Hex);
  if (parsed.data.fingerprint === fingerprint) continue;
  writeFileSync(path, `${JSON.stringify({ ...raw, fingerprint }, null, 2)}\n`);
  console.log(`${file} -> ${fingerprint}`);
  rewritten += 1;
}
console.log(`rewrote ${rewritten} of ${files.length} envelope(s)`);
