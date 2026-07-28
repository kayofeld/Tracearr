/**
 * enqueueSeerrSync / isSeerrSyncRunning guard tests (mirrors
 * ombiSyncQueue.enqueue.test.ts - QA gap coverage)
 *
 * routes/seerr.ts maps enqueueSeerrSync's thrown MESSAGES to HTTP statuses by
 * substring ('not configured' -> 400, 'already in progress' -> 409). The
 * route tests mock enqueueSeerrSync and hardcode those same strings, so a
 * message drift in jobs/seerrSyncQueue.ts would silently turn a 400/409 into
 * a 500 without failing any test. These tests pin the real thrown messages
 * (and the guard logic itself) with BullMQ mocked out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueInstance } = vi.hoisted(() => ({
  queueInstance: {
    add: vi.fn(),
    getJobs: vi.fn(),
    getJobSchedulers: vi.fn(),
    removeJobScheduler: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  },
}));

// Implementations must be `function`s, not arrows, so `new Queue(...)` /
// `new Redis(...)` work - an explicit object return from a constructor
// function replaces `this` (same pattern as seerrSyncQueue.test.ts).
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () {
    return queueInstance;
  }),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { quit: vi.fn(), keys: vi.fn().mockResolvedValue([]), del: vi.fn() };
  }),
}));

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../services/cache.js', () => ({ getPubSubService: vi.fn(() => null) }));
vi.mock('../../serverState.js', () => ({ isMaintenance: () => false }));
vi.mock('../../services/seerr.js', () => ({ SeerrService: vi.fn() }));
vi.mock('../../services/settings.js', () => ({
  getSeerrSettings: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { getSeerrSettings } from '../../services/settings.js';
import { initSeerrSyncQueue, enqueueSeerrSync, isSeerrSyncRunning } from '../seerrSyncQueue.js';

describe('enqueueSeerrSync guards (module-level queue state - tests run in order)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws before the queue is initialized', async () => {
    await expect(enqueueSeerrSync()).rejects.toThrow(/not initialized/);
  });

  it('isSeerrSyncRunning returns false before the queue is initialized', async () => {
    await expect(isSeerrSyncRunning()).resolves.toBe(false);
  });

  it('rejects with a message containing "not configured" when Seerr settings are missing (route maps this to 400)', async () => {
    initSeerrSyncQueue('redis://localhost:6379');
    vi.mocked(getSeerrSettings).mockResolvedValue({ seerrUrl: null, seerrApiKey: null });

    // The exact substring routes/seerr.ts greps for - do not weaken this assertion.
    await expect(enqueueSeerrSync()).rejects.toThrow(/not configured/);
    expect(queueInstance.getJobs).not.toHaveBeenCalled();
    expect(queueInstance.add).not.toHaveBeenCalled();
  });

  it('rejects with a message containing "already in progress" when an active/waiting job exists (route maps this to 409)', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'key',
    });
    queueInstance.getJobs.mockResolvedValue([{ id: 'existing-job' }]);

    // The exact substring routes/seerr.ts greps for - do not weaken this assertion.
    await expect(enqueueSeerrSync()).rejects.toThrow(/already in progress/);
    expect(queueInstance.getJobs).toHaveBeenCalledWith(['active', 'waiting']);
    expect(queueInstance.add).not.toHaveBeenCalled();
  });

  it('enqueues a manual job and returns its id when configured and idle', async () => {
    vi.mocked(getSeerrSettings).mockResolvedValue({
      seerrUrl: 'http://localhost:5055',
      seerrApiKey: 'key',
    });
    queueInstance.getJobs.mockResolvedValue([]);
    queueInstance.add.mockResolvedValue({ id: 'manual-seerr-sync-42' });

    const jobId = await enqueueSeerrSync('owner-user-id');

    expect(jobId).toBe('manual-seerr-sync-42');
    expect(queueInstance.add).toHaveBeenCalledWith(
      'manual-sync',
      { triggeredBy: 'manual', userId: 'owner-user-id' },
      expect.objectContaining({ jobId: expect.stringContaining('manual-seerr-sync-') })
    );
  });

  it('isSeerrSyncRunning reflects active jobs on the initialized queue', async () => {
    queueInstance.getJobs.mockResolvedValue([{ id: 'active-1' }]);
    await expect(isSeerrSyncRunning()).resolves.toBe(true);

    queueInstance.getJobs.mockResolvedValue([]);
    await expect(isSeerrSyncRunning()).resolves.toBe(false);
  });
});
