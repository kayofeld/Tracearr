import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const { mockReverifyKillCondition, mockStoreActionResults } = vi.hoisted(() => ({
  mockReverifyKillCondition: vi.fn(),
  mockStoreActionResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/rules/reverify.js', () => ({
  reverifyKillCondition: mockReverifyKillCondition,
}));

vi.mock('../../services/rules/v2Integration.js', () => ({
  storeActionResults: mockStoreActionResults,
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return {
      on: vi.fn(),
      close: mockWorkerClose,
    };
  }),
}));

import {
  initKillQueue,
  enqueueKill,
  processKillJob,
  shutdownKillQueue,
  type KillJobData,
} from '../killQueue.js';
import type { Job } from 'bullmq';

function makeJob(data: KillJobData): Job<KillJobData> {
  return { data } as unknown as Job<KillJobData>;
}

describe('killQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueAdd.mockReset();
    await shutdownKillQueue();
    initKillQueue('redis://localhost:6379');
  });

  describe('enqueueKill', () => {
    it('carries delay_seconds through as milliseconds', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });

      const data: KillJobData = {
        sessionId: randomUUID(),
        serverId: randomUUID(),
        ruleId: randomUUID(),
        violationId: randomUUID(),
      };

      await enqueueKill(data, 30);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual(data);
      expect(opts.delay).toBe(30000);
    });

    it('uses zero delay when delaySeconds is 0', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-2' });

      const data: KillJobData = {
        sessionId: randomUUID(),
        serverId: randomUUID(),
        ruleId: randomUUID(),
        violationId: null,
      };

      await enqueueKill(data, 0);

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.delay).toBe(0);
    });

    it('builds jobId from violationId and sessionId for dedup', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3' });

      const sessionId = randomUUID();
      const violationId = randomUUID();

      await enqueueKill(
        { sessionId, serverId: randomUUID(), ruleId: randomUUID(), violationId },
        10
      );

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.jobId).toBe(`kill:${violationId}:${sessionId}`);
    });

    it('builds jobId from ruleId and sessionId when violationId is null', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3b' });

      const sessionId = randomUUID();
      const ruleId = randomUUID();

      await enqueueKill({ sessionId, serverId: randomUUID(), ruleId, violationId: null }, 10);

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.jobId).toBe(`kill:rule:${ruleId}:${sessionId}`);
    });

    it('gives distinct jobIds to distinct rules matching the same session when violationId is null', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3c' });

      const sessionId = randomUUID();
      const ruleIdA = randomUUID();
      const ruleIdB = randomUUID();

      await enqueueKill(
        { sessionId, serverId: randomUUID(), ruleId: ruleIdA, violationId: null },
        10
      );
      await enqueueKill(
        { sessionId, serverId: randomUUID(), ruleId: ruleIdB, violationId: null },
        10
      );

      const jobIdA = mockQueueAdd.mock.calls[0]![2].jobId;
      const jobIdB = mockQueueAdd.mock.calls[1]![2].jobId;
      expect(jobIdA).not.toBe(jobIdB);
      expect(jobIdA).toBe(`kill:rule:${ruleIdA}:${sessionId}`);
      expect(jobIdB).toBe(`kill:rule:${ruleIdB}:${sessionId}`);
    });

    it('gives distinct jobIds to each session when a multi-target match kills several sessions', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3d' });

      const violationId = randomUUID();
      const ruleId = randomUUID();
      const sessionIdA = randomUUID();
      const sessionIdB = randomUUID();

      await enqueueKill({ sessionId: sessionIdA, serverId: randomUUID(), ruleId, violationId }, 0);
      await enqueueKill({ sessionId: sessionIdB, serverId: randomUUID(), ruleId, violationId }, 0);

      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      const jobIdA = mockQueueAdd.mock.calls[0]![2].jobId;
      const jobIdB = mockQueueAdd.mock.calls[1]![2].jobId;
      expect(jobIdA).not.toBe(jobIdB);
      expect(jobIdA).toBe(`kill:${violationId}:${sessionIdA}`);
      expect(jobIdB).toBe(`kill:${violationId}:${sessionIdB}`);
    });

    it('carries an identityServerUserIds snapshot through to the job payload', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3e' });

      const data: KillJobData = {
        sessionId: randomUUID(),
        serverId: randomUUID(),
        ruleId: randomUUID(),
        violationId: randomUUID(),
        identityServerUserIds: ['su-1', 'su-2'],
      };

      await enqueueKill(data, 0);

      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual(data);
    });

    it('does not double-enqueue a duplicate jobId', async () => {
      mockQueueAdd.mockRejectedValue(new Error('Job with id kill:abc:def already exists'));

      const result = await enqueueKill(
        {
          sessionId: randomUUID(),
          serverId: randomUUID(),
          ruleId: randomUUID(),
          violationId: randomUUID(),
        },
        5
      );

      expect(result).toBeUndefined();
    });

    it('rethrows unexpected queue errors', async () => {
      mockQueueAdd.mockRejectedValue(new Error('redis connection lost'));

      await expect(
        enqueueKill(
          {
            sessionId: randomUUID(),
            serverId: randomUUID(),
            ruleId: randomUUID(),
            violationId: randomUUID(),
          },
          5
        )
      ).rejects.toThrow('redis connection lost');
    });
  });

  describe('processKillJob', () => {
    it('stores a killed outcome as a successful, non-skipped action result', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });

      const violationId = randomUUID();
      const ruleId = randomUUID();
      const jobData: KillJobData = {
        sessionId: randomUUID(),
        serverId: randomUUID(),
        ruleId,
        violationId,
        message: 'bye',
      };

      await processKillJob(makeJob(jobData));

      expect(mockReverifyKillCondition).toHaveBeenCalledWith({
        sessionId: jobData.sessionId,
        serverId: jobData.serverId,
        ruleId,
        message: 'bye',
      });
      expect(mockStoreActionResults).toHaveBeenCalledWith(violationId, ruleId, [
        expect.objectContaining({ success: true, skipped: false }),
      ]);
    });

    it('stores each skipped outcome with the exact skipReason literal', async () => {
      for (const outcome of [
        'skipped_already_stopped',
        'skipped_rule_gone',
        'skipped_condition_cleared',
      ] as const) {
        mockStoreActionResults.mockClear();
        mockReverifyKillCondition.mockResolvedValue({ outcome });

        const violationId = randomUUID();
        const ruleId = randomUUID();

        await processKillJob(
          makeJob({ sessionId: randomUUID(), serverId: randomUUID(), ruleId, violationId })
        );

        expect(mockStoreActionResults).toHaveBeenCalledWith(violationId, ruleId, [
          expect.objectContaining({ success: true, skipped: true, skipReason: outcome }),
        ]);
      }
    });

    it('stores a failed outcome as unsuccessful', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'failed', error: 'boom' });

      const violationId = randomUUID();
      const ruleId = randomUUID();

      await processKillJob(
        makeJob({ sessionId: randomUUID(), serverId: randomUUID(), ruleId, violationId })
      );

      expect(mockStoreActionResults).toHaveBeenCalledWith(violationId, ruleId, [
        expect.objectContaining({ success: false }),
      ]);
    });

    it('passes a null violationId through to storeActionResults unchanged', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });

      const ruleId = randomUUID();

      await processKillJob(
        makeJob({ sessionId: randomUUID(), serverId: randomUUID(), ruleId, violationId: null })
      );

      expect(mockStoreActionResults).toHaveBeenCalledWith(null, ruleId, expect.any(Array));
    });
  });
});
