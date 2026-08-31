/**
 * Restore progress is served by the unauthenticated /health endpoint, so
 * whatever setPhase stores is world-readable. Raw psql/pg_restore stderr and
 * the absolute restore-point path must stay in the log, not in the response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyRestoreError } from '../restoreOrchestrator.js';

describe('classifyRestoreError', () => {
  beforeEach(() => undefined);

  it('replaces pg_restore stderr with a fixed string', () => {
    const stderr =
      'pg_restore: error: could not open file "/data/backup/restore-point-2026-08-11.dump": No such file or directory';

    const result = classifyRestoreError(stderr);

    expect(result).toBe('restore failed - see server logs');
    expect(result).not.toContain('pg_restore');
    expect(result).not.toContain('/data/backup');
  });

  it('never echoes a filesystem path', () => {
    expect(classifyRestoreError('/data/backup/secret.dump exploded')).not.toContain('/data');
  });

  it('never echoes connection detail', () => {
    const result = classifyRestoreError(
      'psql: error: connection to server at "10.0.0.5", port 5432 failed: FATAL: password authentication failed for user "tracearr"'
    );
    expect(result).not.toContain('10.0.0.5');
    expect(result).not.toContain('password');
  });

  it('handles a non-string input', () => {
    expect(classifyRestoreError(undefined)).toBe('restore failed - see server logs');
    expect(classifyRestoreError(new Error('boom'))).toBe('restore failed - see server logs');
  });
});
