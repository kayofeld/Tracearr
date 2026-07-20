import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Absolute path to the repo root. This module compiles to
 * apps/server/dist/lib/, which is four levels below the root.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
