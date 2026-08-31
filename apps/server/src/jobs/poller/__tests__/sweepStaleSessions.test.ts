/**
 * sweepStaleSessions tests.
 *
 * The stale sweep force-stops sessions the poller lost track of (no poll saw
 * them in 5+ minutes): stopSessionAtomic writes the row and dispatches
 * session.stopped, the sweep publishes `session:stopped` and cleans the cache.
 * It enqueues nothing of its own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const mockStopSessionAtomic = vi.fn();
const mockEnqueueNotification = vi.fn();

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
  enqueueNotification: (...args: unknown[]) => mockEnqueueNotification(...args),
}));

vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
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
  handleQualityChangeFallout: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

import { initializePoller, sweepStaleSessions } from '../processor.js';

const staleSessionRow = {
  id: 'session-1',
  serverId: 'server-1',
  serverUserId: 'server-user-1',
  sessionKey: 'key-1',
  plexSessionId: 'plex-sess-1',
  lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
  startedAt: new Date(Date.now() - 20 * 60 * 1000),
  stoppedAt: null,
};

/** The one query sweepStaleSessions issues: the stale rows themselves. */
function mockDbSequence(staleRows: unknown[]) {
  mockDbSelect.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(staleRows) }) });
}

describe('sweepStaleSessions', () => {
  const cacheService = {
    removeActiveSession: vi.fn(),
    addSessionWriteRetry: vi.fn(),
    invalidateDashboardStatsCache: vi.fn(),
  };
  const pubSubService = { publish: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    initializePoller(cacheService as never, pubSubService as never);
  });

  it('force-stops the stale session and leaves the notification to the automations', async () => {
    mockDbSequence([staleSessionRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 456000,
      watched: true,
      shortSession: false,
      wasUpdated: true,
    });

    await sweepStaleSessions();

    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    expect(mockStopSessionAtomic.mock.calls[0]?.[0]).toMatchObject({
      session: staleSessionRow,
      forceStopped: true,
    });
    expect(pubSubService.publish).toHaveBeenCalledWith('session:stopped', 'session-1');
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('removes the cache entry without invalidating per-session, then invalidates dashboard stats once', async () => {
    mockDbSequence([staleSessionRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 456000,
      watched: true,
      shortSession: false,
      wasUpdated: true,
    });

    await sweepStaleSessions();

    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('session-1', {
      skipDashboardInvalidation: true,
    });
    expect(cacheService.invalidateDashboardStatsCache).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate dashboard stats when no session was actually force-stopped', async () => {
    mockDbSequence([staleSessionRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: null,
      watched: false,
      shortSession: false,
      wasUpdated: false,
    });

    await sweepStaleSessions();

    expect(cacheService.removeActiveSession).not.toHaveBeenCalled();
    expect(cacheService.invalidateDashboardStatsCache).not.toHaveBeenCalled();
  });
});
