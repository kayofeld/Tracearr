/**
 * Reentrancy Guard Tests
 *
 * triggerReconciliationPoll and triggerServerPoll can both be invoked from
 * multiple concurrent triggers (the 30s reconciliation timer, an SSE
 * reconnect, and the SSE-plugin debounce timer respectively). These tests
 * verify a second concurrent call is skipped while the first is in flight.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

vi.mock('../../../services/sseManager.js', () => ({
  sseManager: {
    isInFallback: vi.fn().mockReturnValue(false),
    nudgeReconnect: vi.fn(),
  },
}));

vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock('../database.js', () => ({
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  stopSessionAtomic: vi.fn(),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

import { triggerReconciliationPoll, triggerServerPoll } from '../processor.js';

/** Deferred promise helper for controlling when a mocked async call resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('reentrancy guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('triggerReconciliationPoll', () => {
    it('skips a second concurrent call while the first is still in flight', async () => {
      const gate = deferred<unknown[]>();
      mockDbSelect.mockReturnValue({ from: () => gate.promise });

      const first = triggerReconciliationPoll();
      const second = triggerReconciliationPoll();

      // The second call returns without ever touching the db, since the
      // guard check happens synchronously before any await in the function.
      await second;
      expect(mockDbSelect).toHaveBeenCalledTimes(1);

      gate.resolve([]);
      await first;
    });

    it('allows a new run once the previous one has finished', async () => {
      mockDbSelect.mockReturnValue({ from: () => Promise.resolve([]) });

      await triggerReconciliationPoll();
      await triggerReconciliationPoll();

      expect(mockDbSelect).toHaveBeenCalledTimes(2);
    });
  });

  describe('triggerServerPoll', () => {
    it('skips a second concurrent call for the same server while one is in flight', async () => {
      const gate = deferred<unknown[]>();
      mockDbSelect.mockReturnValue({ from: () => ({ where: () => gate.promise }) });

      const first = triggerServerPoll('server-1');
      const second = triggerServerPoll('server-1');

      await second;
      expect(mockDbSelect).toHaveBeenCalledTimes(1);

      gate.resolve([]);
      await first;
    });

    it('does not block concurrent calls for a different server', async () => {
      const gateA = deferred<unknown[]>();
      const gateB = deferred<unknown[]>();
      let call = 0;
      mockDbSelect.mockImplementation(() => {
        call++;
        const gate = call === 1 ? gateA : gateB;
        return { from: () => ({ where: () => gate.promise }) };
      });

      const first = triggerServerPoll('server-1');
      const second = triggerServerPoll('server-2');

      gateA.resolve([]);
      gateB.resolve([]);
      await Promise.all([first, second]);

      expect(mockDbSelect).toHaveBeenCalledTimes(2);
    });
  });
});
