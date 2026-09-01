/**
 * SSE Processor Tests - Server Health Events
 *
 * Tests the fallback:activated and fallback:deactivated handlers:
 * - The server.down dispatch is delayed by threshold (60s)
 * - Server up cancels the pending dispatch if it recovered before threshold
 * - Server up dispatches only when the server was marked down
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

// Create mocks using vi.hoisted - must require EventEmitter inside for hoisting to work
const { mockSseManager, mockEnqueueNotification, mockDispatch, mockGetActiveAutomations } =
  vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter: EE } = require('events');
    return {
      mockSseManager: new EE() as EventEmitter,
      mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
      mockDispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
      mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
    };
  });

// Mock the sseManager
vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

// Mock enqueueNotification
vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

// Mock other dependencies
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn(),
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: vi.fn(),
  detectMediaChange: vi.fn(),
  // Playback confirmation functions for delayed rule evaluation
  isPlaybackConfirmed: vi.fn().mockReturnValue(false),
  createInitialConfirmationState: vi.fn().mockReturnValue({
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  }),
  updateConfirmationState: vi.fn().mockImplementation((state) => state),
}));

vi.mock('../poller/database.js', () => ({
  getServerUserIdByExternalId: vi.fn(() => {
    throw new Error('getServerUserIdByExternalId not configured in this test');
  }),
  getActiveAutomations: mockGetActiveAutomations,
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn(),
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionsAll: vi.fn(),
  buildActiveSession: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));

vi.mock('../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));
vi.mock('../../services/automations/events/contextAssembly.js', () => ({
  loadEvaluationContext: vi.fn().mockResolvedValue(null),
  loadServerContext: vi.fn(async (serverId: string) => ({
    server: { id: serverId, name: 'Test Server', type: 'plex' },
    inputs: {
      activeAutomations: [],
      activeSessions: [],
      recentSessions: [],
      identityServerUserIds: [],
    },
  })),
  serverContextFor: vi.fn(),
  installInputs: vi.fn(),
  assembleEvaluationInputs: vi.fn().mockResolvedValue({
    activeAutomations: [],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  }),
  setContextAssemblyDeps: vi.fn(),
}));

// Import after mocking
import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import { triggerReconciliationPoll } from '../poller/index.js';

// Mock cache and pubsub services
const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
  addUserSession: vi.fn(),
  removeUserSession: vi.fn(),
  withSessionCreateLock: vi.fn(),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  setTerminationCooldown: vi.fn(),
  hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
  setTerminationCooldownComposite: vi.fn(),
  // Pending session methods for delayed rule evaluation
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

describe('SSE Processor - Server Health Notifications', () => {
  const listening = [
    {
      id: 'a1',
      triggers: [
        { id: 'n1', type: 'server.down', enabled: true },
        { id: 'n2', type: 'server.up', enabled: true },
      ],
    },
  ];
  const down = (serverId: string, serverName: string) =>
    mockSseManager.emit('fallback:activated', { serverId, serverName });
  const up = (serverId: string, serverName: string) =>
    mockSseManager.emit('fallback:deactivated', { serverId, serverName });
  const dispatched = (type: 'server.down' | 'server.up', serverId: string) =>
    mockDispatch.mock.calls.filter(
      (call) =>
        (call[0] as { type: string; server: { id: string } }).type === type &&
        (call[0] as { server: { id: string } }).server.id === serverId
    );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetActiveAutomations.mockResolvedValue(listening);
    mockSseManager.removeAllListeners();

    // Initialize and start the processor
    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
    vi.useRealTimers();
  });

  describe('fallback:activated (server goes down)', () => {
    it('holds the server.down dispatch for the 60s threshold', async () => {
      down('server-1', 'Test Server');

      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockDispatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockDispatch).toHaveBeenCalledWith(
        {
          type: 'server.down',
          at: expect.any(Date),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
        },
        expect.objectContaining({ activeSessions: [] })
      );
    });

    it('leaves the notification to whatever automation listens for the trigger', async () => {
      down('server-1', 'Test Server');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });

    it('dispatches nothing when no automation listens for server.down', async () => {
      mockGetActiveAutomations.mockResolvedValue([]);
      down('server-1', 'Test Server');

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('should handle multiple servers going down independently', async () => {
      down('server-1', 'Server 1');

      // 30 seconds later, Server 2 goes down
      await vi.advanceTimersByTimeAsync(30_000);
      down('server-2', 'Server 2');

      // At 60s, only Server 1 has reached its threshold
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dispatched('server.down', 'server-1')).toHaveLength(1);
      expect(dispatched('server.down', 'server-2')).toHaveLength(0);

      // At 90s (60s after Server 2), Server 2 follows
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dispatched('server.down', 'server-2')).toHaveLength(1);
    });

    it('should replace pending notification if same server triggers again', async () => {
      down('server-1', 'Test Server');

      // 30 seconds later, same server triggers fallback again (e.g., retry logic)
      await vi.advanceTimersByTimeAsync(30_000);
      down('server-1', 'Test Server');

      // Original 60s would be at 60s, but we reset, so need 60s from second trigger
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockDispatch).not.toHaveBeenCalled();

      // 60s from second trigger (at 90s total)
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dispatched('server.down', 'server-1')).toHaveLength(1);
    });
  });

  describe('fallback:deactivated (server comes back up)', () => {
    it('should cancel pending notification if server recovers before threshold', async () => {
      down('server-1', 'Test Server');

      // Server comes back up after 30 seconds (before 60s threshold)
      await vi.advanceTimersByTimeAsync(30_000);
      up('server-1', 'Test Server');

      // Even after the original threshold passes, nothing announces it went down
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dispatched('server.down', 'server-1')).toHaveLength(0);
    });

    it('dispatches server.up once the server was marked down', async () => {
      down('server-1', 'Test Server');
      await vi.advanceTimersByTimeAsync(60_000);
      mockDispatch.mockClear();

      up('server-1', 'Test Server');
      await vi.runAllTimersAsync();

      expect(mockDispatch).toHaveBeenCalledWith(
        {
          type: 'server.up',
          at: expect.any(Date),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
        },
        expect.objectContaining({ activeSessions: [] })
      );
      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });

    it('should not send server_up if server was never marked as down', async () => {
      // Server comes up without ever going down (e.g., initial connection)
      up('server-1', 'Test Server');

      await vi.runAllTimersAsync();

      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('should trigger a reconciliation poll on reconnect to catch missed sessions', async () => {
      up('server-1', 'Test Server');

      await vi.runAllTimersAsync();

      expect(vi.mocked(triggerReconciliationPoll)).toHaveBeenCalled();
    });
  });

  describe('stopSSEProcessor cleanup', () => {
    it('should clear pending notifications on stop', async () => {
      down('server-1', 'Test Server');

      // Stop processor before threshold
      await vi.advanceTimersByTimeAsync(30_000);
      stopSSEProcessor();

      // Even after threshold, nothing fires (timer was cleared)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('should clear multiple pending notifications on stop', async () => {
      down('server-1', 'Server 1');
      down('server-2', 'Server 2');
      down('server-3', 'Server 3');

      stopSSEProcessor();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('survives a dispatch that throws when the threshold trips', async () => {
      mockDispatch.mockRejectedValueOnce(new Error('dispatch error'));

      down('server-1', 'Test Server');

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDispatch).toHaveBeenCalled();
    });
  });
});
