import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../db/client.js', () => ({
  closeDatabase: vi.fn().mockResolvedValue(undefined),
  recreatePool: vi.fn().mockResolvedValue(undefined),
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/auth.js', () => ({
  closeAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../backup.js', () => ({
  checkDumpCompatibility: vi.fn().mockResolvedValue(undefined),
  createRestorePoint: vi.fn().mockResolvedValue('/data/backup/restore-point-20260711.dump'),
  extractDump: vi
    .fn()
    .mockResolvedValue({ dumpPath: '/tmp/dump/database.dump', tempDir: '/tmp/dump' }),
  restoreDatabase: vi.fn().mockResolvedValue(undefined),
  purgeRedisKeys: vi.fn().mockResolvedValue(0),
  cleanupTailscaleState: vi.fn(),
}));

vi.mock('../../serverState.js', () => ({
  isRestoring: vi.fn().mockReturnValue(false),
  setRestoring: vi.fn(),
  setRestoreProgress: vi.fn(),
  setServerMode: vi.fn(),
}));

vi.mock('../settings.js', () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
  resetSettingsCache: vi.fn(),
}));

vi.mock('../../plugins/auth.js', () => ({
  loadJwtRevokeSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/timescale.js', () => ({
  initTimescaleDB: vi.fn().mockResolvedValue({ actions: [] }),
}));

import { recreatePool } from '../../db/client.js';
import { closeAuth } from '../../lib/auth.js';
import { restoreDatabase, createRestorePoint } from '../backup.js';
import { setRestoring } from '../../serverState.js';
import { orchestrateRestore } from '../restoreOrchestrator.js';

function fakeApp(): FastifyInstance {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyInstance;
}

describe('orchestrateRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recreatePool).mockResolvedValue(undefined);
    vi.mocked(closeAuth).mockResolvedValue(undefined);
    vi.mocked(restoreDatabase).mockResolvedValue(undefined);
  });

  it('reinitializes the pool and the auth singleton after a successful restore', async () => {
    const app = fakeApp();
    await orchestrateRestore('/data/backup/tracearr-backup-20260711.zip', app);

    expect(recreatePool).toHaveBeenCalledTimes(1);
    expect(closeAuth).toHaveBeenCalledTimes(1);
    const poolOrder = vi.mocked(recreatePool).mock.invocationCallOrder[0]!;
    const authOrder = vi.mocked(closeAuth).mock.invocationCallOrder[0]!;
    expect(poolOrder).toBeLessThan(authOrder);
    expect(vi.mocked(setRestoring).mock.calls.at(-1)).toEqual([false]);
  });

  it('reinitializes the pool and auth singleton after a failed restore whose rollback succeeds', async () => {
    vi.mocked(restoreDatabase)
      .mockRejectedValueOnce(new Error('pg_restore failed (exit code 1): corrupt dump'))
      .mockResolvedValueOnce(undefined);

    const app = fakeApp();
    await orchestrateRestore('/data/backup/tracearr-backup-20260711.zip', app);

    expect(recreatePool).toHaveBeenCalledTimes(1);
    expect(closeAuth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setRestoring).mock.calls.at(-1)).toEqual([false]);
  });

  it('still reinitializes the pool and auth singleton when both the restore and its rollback fail', async () => {
    vi.mocked(restoreDatabase)
      .mockRejectedValueOnce(new Error('pg_restore failed (exit code 1): corrupt dump'))
      .mockRejectedValueOnce(
        new Error('pg_restore failed (exit code 1): restore point unreadable')
      );

    const app = fakeApp();
    await orchestrateRestore('/data/backup/tracearr-backup-20260711.zip', app);

    expect(recreatePool).toHaveBeenCalledTimes(1);
    expect(closeAuth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setRestoring).mock.calls.at(-1)).toEqual([false]);
  });

  it('reinitializes the pool and auth singleton on failure even with no restore point', async () => {
    vi.mocked(createRestorePoint).mockRejectedValueOnce(new Error('disk full'));

    const app = fakeApp();
    await orchestrateRestore('/data/backup/tracearr-backup-20260711.zip', app);

    expect(recreatePool).toHaveBeenCalledTimes(1);
    expect(closeAuth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setRestoring).mock.calls.at(-1)).toEqual([false]);
  });
});
