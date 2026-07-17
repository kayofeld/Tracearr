/**
 * SSE Processor Tests - Media Change Detection
 *
 * Tests that the SSE processor correctly detects when Plex reuses a sessionKey
 * with a different ratingKey (e.g., auto-play next episode) and atomically
 * stops the old session + creates a new one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import {
  clearDbWriteTracking,
  recordDbWrite,
  shouldFlushDbWrite,
} from '../poller/dbWriteThrottle.js';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockHandleMediaChangeAtomic,
  mockBuildActiveSession,
  mockDetectMediaChange,
  mockGetActiveRulesV2,
  mockBatchGetRecentUserSessions,
  mockBroadcastViolations,
  mockCreateMediaServerClient,
  mockDb,
  mockLookupGeoIP,
  mockGetGeoIPSettings,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn(),
    mockHandleMediaChangeAtomic: vi.fn(),
    mockBuildActiveSession: vi.fn(),
    mockDetectMediaChange: vi.fn(),
    mockGetActiveRulesV2: vi.fn().mockResolvedValue([]),
    mockBatchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    mockBroadcastViolations: vi.fn(),
    mockCreateMediaServerClient: vi.fn(),
    mockDb: {
      select: vi.fn(),
      update: vi.fn(),
    },
    mockLookupGeoIP: vi
      .fn()
      .mockResolvedValue({ city: null, country: null, latitude: null, longitude: null }),
    mockGetGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
  };
});

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../db/client.js', () => ({
  db: mockDb,
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../services/plexGeoip.js', () => ({
  lookupGeoIP: mockLookupGeoIP,
}));

vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: mockGetGeoIPSettings,
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn((session: unknown) => session),
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: vi.fn(),
  detectMediaChange: mockDetectMediaChange,
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
  getActiveRulesV2: mockGetActiveRulesV2,
  batchGetRecentUserSessions: mockBatchGetRecentUserSessions,
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: mockBroadcastViolations,
}));

vi.mock('../poller/sessionLifecycle.js', async () => {
  // handleQualityChangeFallout is left as the real implementation so the
  // media-change-onto-tracked-content test can observe its actual throttle/
  // cache/publish effects on the twin, not just that it was called.
  const actual = await vi.importActual<typeof SessionLifecycleModule>(
    '../poller/sessionLifecycle.js'
  );
  return {
    ...actual,
    stopSessionAtomic: vi.fn(),
    findActiveSession: mockFindActiveSession,
    findActiveSessionsAll: vi.fn().mockResolvedValue([]),
    buildActiveSession: mockBuildActiveSession,
    handleMediaChangeAtomic: mockHandleMediaChangeAtomic,
    reEvaluateRulesOnTranscodeChange: vi.fn(),
    confirmAndPersistSession: vi.fn(),
  };
});

// ============================================================================
// Import after mocking
// ============================================================================

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import type * as SessionLifecycleModule from '../poller/sessionLifecycle.js';

// ============================================================================
// Test fixtures
// ============================================================================

const SERVER_ID = 'server-1';

const mockServer = {
  id: SERVER_ID,
  name: 'Test Plex',
  type: 'plex',
  url: 'http://localhost:32400',
  token: 'test-token',
};

const mockExistingSession = {
  id: 'session-old',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1001', // Episode 1
  state: 'playing' as const,
  startedAt: new Date('2026-01-01'),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: false,
  totalDurationMs: 3600000,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
};

const mockProcessedSession = {
  sessionKey: '42', // Same sessionKey (Plex reuses it)
  ratingKey: '1002', // Different ratingKey — Episode 2
  state: 'playing' as const,
  mediaType: 'episode' as const,
  mediaTitle: 'Episode 2',
  grandparentTitle: 'Test Show',
  seasonNumber: 1,
  episodeNumber: 2,
  year: 2026,
  thumbPath: '/thumb',
  totalDurationMs: 3600000,
  progressMs: 0,
  ipAddress: '192.168.1.100',
  playerName: 'Plex Web',
  deviceId: 'device-1',
  product: 'Plex Web',
  device: 'Chrome',
  platform: 'Windows',
  quality: '1080p',
  isTranscode: false,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
  bitrate: 10000,
  externalUserId: 'plex-user-1',
  channelTitle: null,
  channelIdentifier: null,
  channelThumb: null,
  artistName: null,
  albumName: null,
  trackNumber: null,
  discNumber: null,
};

const mockServerUser = {
  id: 'server-user-1',
  userId: 'identity-1',
  username: 'testuser',
  thumbUrl: null,
  identityName: 'Test User',
  trustScore: 100,
  sessionCount: 5,
  lastActivityAt: new Date('2026-01-01'),
};

const mockNewSession = {
  id: 'session-new',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1002',
  startedAt: new Date(),
  lastPausedAt: null,
  pausedDurationMs: null,
  referenceId: null,
  watched: false,
};

const mockActiveSession = {
  id: 'session-new',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1002',
  state: 'playing',
  mediaTitle: 'Episode 2',
};

// ============================================================================
// Mock cache and pubsub services
// ============================================================================

const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Set up mocks for fetchFullSession to return a valid session + server
 */
function setupFetchFullSession(processed: Record<string, unknown> = mockProcessedSession) {
  const mockGetSessions = vi.fn().mockResolvedValue([processed]);
  mockCreateMediaServerClient.mockReturnValue({ getSessions: mockGetSessions });

  // Mock db.select().from(servers).where().limit() chain
  const limitFn = vi.fn().mockResolvedValue([mockServer]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValue({ from: fromFn });
}

/**
 * Set up mocks for the server user DB query inside handleMediaChange
 */
function setupServerUserQuery() {
  // After fetchFullSession completes, handleMediaChange also calls db.select()
  // We need a more flexible mock chain for the inner join query
  const limitFn = vi.fn().mockResolvedValue([mockServerUser]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });

  // getIdentityServerUserIds: db.select({...}).from(serverUsers).where() (no join, no limit)
  const identityWhereFn = vi.fn().mockResolvedValue([mockServerUser]);
  const identityFromFn = vi.fn().mockReturnValue({ where: identityWhereFn });

  // Track call count — first call is fetchFullSession (servers), second is
  // handleMediaChange (serverUsers innerJoin), third is getIdentityServerUserIds
  let callCount = 0;
  const mockGetSessions = vi.fn().mockResolvedValue([mockProcessedSession]);
  mockCreateMediaServerClient.mockReturnValue({ getSessions: mockGetSessions });

  mockDb.select.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // fetchFullSession: db.select().from(servers).where().limit()
      const serverLimitFn = vi.fn().mockResolvedValue([mockServer]);
      const serverWhereFn = vi.fn().mockReturnValue({ limit: serverLimitFn });
      const serverFromFn = vi.fn().mockReturnValue({ where: serverWhereFn });
      return { from: serverFromFn };
    }
    if (callCount === 2) {
      // handleMediaChange: db.select({...}).from(serverUsers).innerJoin().where().limit()
      return { from: fromFn };
    }
    // getIdentityServerUserIds: db.select({...}).from(serverUsers).where()
    return { from: identityFromFn };
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('SSE Processor - Media Change Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();

    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
    clearDbWriteTracking('twin-session-1');
  });

  it('should detect media change and stop old session + create new', async () => {
    setupServerUserQuery();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(true);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    // Allow async handlers to complete
    await vi.waitFor(() => {
      expect(mockHandleMediaChangeAtomic).toHaveBeenCalledTimes(1);
    });

    // Should have stopped old session in cache
    expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith('session-old');

    // Should have broadcast stop for old session
    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', 'session-old');

    // Should have added new session to cache
    expect(mockCacheService.addActiveSession).toHaveBeenCalledWith(mockActiveSession);

    // Should have broadcast start for new session
    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:started', mockActiveSession);

    // Should only enqueue session_started (no session_stopped — matches poller behavior)
    expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
    expect(mockEnqueueNotification).toHaveBeenCalledWith({
      type: 'session_started',
      payload: mockActiveSession,
    });
  });

  it('should not trigger media change for same ratingKey', async () => {
    setupFetchFullSession();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(false);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 5000 },
    });

    // Allow async handlers to complete
    await vi.waitFor(() => {
      expect(mockDetectMediaChange).toHaveBeenCalledTimes(1);
    });

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('should handle null ratingKeys gracefully (no false positive)', async () => {
    const sessionWithNullRating = { ...mockExistingSession, ratingKey: null };
    setupFetchFullSession({ ...mockProcessedSession, ratingKey: null });
    mockFindActiveSession.mockResolvedValue(sessionWithNullRating);
    mockDetectMediaChange.mockReturnValue(false); // detectMediaChange returns false for null keys

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockDetectMediaChange).toHaveBeenCalledWith(null, null, undefined, undefined);
    });

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('should update cache and broadcast for both old and new sessions', async () => {
    setupServerUserQuery();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(true);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockCacheService.addActiveSession).toHaveBeenCalledTimes(1);
    });

    // Verify the order: remove old, then add new
    const removeCall = mockCacheService.removeActiveSession.mock.invocationCallOrder[0]!;
    const addCall = mockCacheService.addActiveSession.mock.invocationCallOrder[0]!;
    expect(removeCall).toBeLessThan(addCall);

    // Verify pubsub events in order: stopped before started
    const publishCalls = mockPubSubService.publish.mock.calls as [string, unknown][];
    const stoppedIdx = publishCalls.findIndex(([event]) => event === 'session:stopped');
    const startedIdx = publishCalls.findIndex(([event]) => event === 'session:started');
    expect(stoppedIdx).toBeLessThan(startedIdx);
  });

  it('should evaluate rules on the new session and broadcast violations', async () => {
    const mockViolations = [
      { type: 'concurrent_streams', ruleId: 'rule-1', sessionId: 'session-new' },
    ];

    setupServerUserQuery();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(true);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: mockViolations,
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockBroadcastViolations).toHaveBeenCalledTimes(1);
    });

    expect(mockBroadcastViolations).toHaveBeenCalledWith(
      mockViolations,
      'session-new',
      mockPubSubService
    );
  });

  it('should handle null result from handleMediaChangeAtomic (race condition)', async () => {
    setupServerUserQuery();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(true);
    mockHandleMediaChangeAtomic.mockResolvedValue(null);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockHandleMediaChangeAtomic).toHaveBeenCalledTimes(1);
    });

    // Should not update cache or broadcast when result is null
    expect(mockCacheService.removeActiveSession).not.toHaveBeenCalled();
    expect(mockCacheService.addActiveSession).not.toHaveBeenCalled();
    expect(mockPubSubService.publish).not.toHaveBeenCalled();
  });

  it('cleans up the quality-change twin when the media change lands on already-tracked content', async () => {
    const twinId = 'twin-session-1';
    recordDbWrite(twinId, Date.now());
    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(false);

    setupServerUserQuery();
    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockDetectMediaChange.mockReturnValue(true);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
      wasTerminatedByRule: false,
      qualityChange: {
        stoppedSession: {
          id: twinId,
          serverUserId: 'server-user-1',
          sessionKey: 'twin-key',
          deviceId: 'device-1',
          ratingKey: '1002',
        },
        referenceId: twinId,
      },
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(twinId);
    });

    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', twinId);
    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(true);
  });
});
