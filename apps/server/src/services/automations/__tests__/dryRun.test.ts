import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActiveSession,
  AuthUser,
  CreateAutomationInput,
  EngineAutomation,
  Session,
} from '@tracearr/shared';

vi.mock('../../../utils/logger.js', () => ({
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../userService.js', () => ({
  getIdentityServerUserIds: vi.fn(() => Promise.resolve(['su1'])),
}));

vi.mock('../../../jobs/poller/database.js', () => ({
  batchGetRecentUserSessions: vi.fn(() => Promise.resolve(new Map())),
  mergeRecentSessionsForIdentity: vi.fn(() => []),
  maxWindowHoursFromAutomations: () => 24,
}));

const serverUserRow = {
  id: 'su1',
  userId: 'u1',
  username: 'connor',
  thumbUrl: null,
  identityName: 'Connor',
  trustScore: 90,
  lastActivityAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};
const serverRow = { id: 'srv1', name: 'Plex', type: 'plex' as const };

const reads = { servers: 0 };
let serverUserRows: (typeof serverUserRow)[] = [serverUserRow];

// The account read names its columns; the server read takes the whole row, so the
// argument tells the two selects apart without depending on call order.
vi.mock('../../../db/client.js', () => ({
  db: {
    select: (fields?: unknown) => {
      if (fields === undefined) reads.servers += 1;
      const rows = fields === undefined ? [serverRow] : serverUserRows;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  },
}));

import { evaluateRulesAsync } from '../engine.js';
import { setContextAssemblyDeps, loadEvaluationContext } from '../events/contextAssembly.js';
import { triggerCandidates } from '../events/evaluate.js';
import { DRY_RUN_SESSION_CAP, dryRun, toEngineAutomation } from '../dryRun.js';

const TRIGGER_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_TRIGGER_ID = '11111111-1111-4111-8111-111111111112';
const CONDITION_ID = '22222222-2222-4222-8222-222222222222';
const KILL_ID = '33333333-3333-4333-8333-333333333333';
const IF_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const TRUST_ID = '66666666-6666-4666-8666-666666666666';
const PAUSED_ID = '77777777-7777-4777-8777-777777777777';

const owner: AuthUser = { userId: 'auth1', username: 'owner', role: 'owner', serverIds: [] };

function session(id: string, mediaType: string): ActiveSession {
  return {
    id,
    serverId: 'srv1',
    serverUserId: 'su1',
    mediaType,
    state: 'playing',
  } as unknown as ActiveSession;
}

const movie = session('sess-movie', 'movie');
const episode = session('sess-episode', 'episode');

function definitionOf(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    name: 'movies only',
    kind: 'policy',
    severity: 'warning',
    triggers: [{ id: TRIGGER_ID, type: 'session.started', enabled: true }],
    conditions: {
      groups: [
        {
          match: 'all',
          conditions: [
            {
              id: CONDITION_ID,
              enabled: true,
              field: 'media_type',
              operator: 'in',
              value: ['movie'],
            },
          ],
        },
      ],
    },
    actions: { actions: [{ id: KILL_ID, enabled: true, type: 'kill_stream' }] },
    ...overrides,
  };
}

beforeEach(() => {
  reads.servers = 0;
  serverUserRows = [serverUserRow];
  setContextAssemblyDeps({
    getAllActiveSessions: () => Promise.resolve([movie, episode]),
    gracePeriodSessionIds: () => new Set<string>(),
  });
});

describe('dryRun', () => {
  it('reports the matching session as would-run and the other with its failing evidence', async () => {
    const { samples } = await dryRun({
      definition: definitionOf(),
      sessions: [movie, episode],
      user: owner,
    });

    expect(samples).toHaveLength(2);
    expect(samples[0]?.subject).toEqual({
      sessionId: 'sess-movie',
      user: { id: 'su1', name: 'Connor' },
      server: { id: 'srv1', name: 'Plex' },
    });
    expect(samples[0]?.wouldRun).toBe(true);
    expect(samples[0]?.conditions).toEqual([
      {
        nodeId: CONDITION_ID,
        passed: true,
        evidence: {
          field: 'media_type',
          operator: 'in',
          threshold: ['movie'],
          actual: 'movie',
          matched: true,
        },
      },
    ]);
    expect(samples[0]?.actions).toEqual([{ nodeId: KILL_ID, wouldRun: true }]);
    expect(samples[0]?.triggers).toEqual(['session.started']);

    expect(samples[1]?.wouldRun).toBe(false);
    expect(samples[1]?.conditions[0]?.passed).toBe(false);
    expect(samples[1]?.conditions[0]?.evidence.actual).toBe('episode');
    expect(samples[1]?.summary).toContain('Would not run');
    expect(samples[1]?.actions).toEqual([
      { nodeId: KILL_ID, wouldRun: false, reason: 'conditions did not match' },
    ]);
  });

  it('evaluates exactly the session it was handed', async () => {
    const { samples } = await dryRun({
      definition: definitionOf(),
      sessions: [episode],
      user: owner,
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]?.subject.sessionId).toBe('sess-episode');
  });

  it('reports a disabled action as one that would not run', async () => {
    const definition = definitionOf({
      actions: { actions: [{ id: KILL_ID, enabled: false, type: 'kill_stream' }] },
    });

    const { samples } = await dryRun({ definition, sessions: [movie], user: owner });

    expect(samples[0]?.wouldRun).toBe(true);
    expect(samples[0]?.actions).toEqual([{ nodeId: KILL_ID, wouldRun: false, reason: 'disabled' }]);
  });

  it('reports which branch an if node takes and holds the other branch back', async () => {
    const definition = definitionOf({
      actions: {
        actions: [
          {
            id: IF_ID,
            enabled: true,
            type: 'if',
            conditions: {
              groups: [
                {
                  match: 'all',
                  conditions: [{ field: 'media_type', operator: 'in', value: ['episode'] }],
                },
              ],
            },
            then: [{ id: MESSAGE_ID, type: 'message_client', message: 'stop' }],
            else: [{ id: TRUST_ID, type: 'trust', mode: 'adjust', amount: -5 }],
          },
        ],
      },
    });

    const { samples } = await dryRun({ definition, sessions: [movie], user: owner });

    expect(samples[0]?.actions).toEqual([
      { nodeId: IF_ID, wouldRun: true, branch: 'else' },
      { nodeId: MESSAGE_ID, wouldRun: false, reason: 'branch not taken' },
      { nodeId: TRUST_ID, wouldRun: true },
    ]);
  });

  it('returns no samples when nothing enabled fires on a session', async () => {
    const definition = definitionOf({
      kind: 'notification',
      severity: null,
      triggers: [{ id: TRIGGER_ID, type: 'server.down', enabled: true }],
      conditions: { groups: [] },
      actions: { actions: [] },
    });

    const { samples } = await dryRun({ definition, sessions: [movie, episode], user: owner });

    expect(samples).toEqual([]);
  });

  it('never replays a live session as a new device, but still samples its other triggers', async () => {
    const deviceOnly = definitionOf({
      kind: 'notification',
      severity: null,
      triggers: [{ id: TRIGGER_ID, type: 'account.new_device', enabled: true }],
      conditions: { groups: [] },
      actions: { actions: [] },
    });

    // A playing session's own row already matches the probe, so there is nothing to re-test.
    expect(
      (await dryRun({ definition: deviceOnly, sessions: [movie], user: owner })).samples
    ).toEqual([]);

    const alongside = definitionOf({
      kind: 'notification',
      severity: null,
      triggers: [
        { id: TRIGGER_ID, type: 'account.new_device', enabled: true },
        { id: SECOND_TRIGGER_ID, type: 'session.started', enabled: true },
      ],
      conditions: { groups: [] },
      actions: { actions: [] },
    });

    const { samples } = await dryRun({ definition: alongside, sessions: [movie], user: owner });

    expect(samples).toHaveLength(1);
    expect(samples[0]?.triggers).toEqual(['session.started']);
  });

  it('says which trigger it stood in for when the draft has no session.started', async () => {
    const definition = definitionOf({
      triggers: [{ id: TRIGGER_ID, type: 'session.paused', enabled: true }],
    });

    const { samples } = await dryRun({ definition, sessions: [movie], user: owner });

    expect(samples[0]?.triggers).toEqual(['session.paused']);
    expect(samples[0]?.summary).toContain('session.paused');
  });

  it('keeps quiet about stand-ins when the draft fires on session.started as well', async () => {
    const definition = definitionOf({
      triggers: [
        { id: TRIGGER_ID, type: 'session.started', enabled: true },
        { id: PAUSED_ID, type: 'session.paused', enabled: true },
      ],
    });

    const { samples } = await dryRun({ definition, sessions: [movie], user: owner });

    expect(samples[0]?.triggers).toEqual(['session.started', 'session.paused']);
    expect(samples[0]?.summary).not.toContain('rather than');
  });

  it('says so when the session it replayed has already stopped', async () => {
    const stopped = { ...session('sess-stopped', 'movie'), state: 'stopped' } as ActiveSession;

    const { samples } = await dryRun({
      definition: definitionOf(),
      sessions: [stopped],
      user: owner,
    });

    expect(samples[0]?.summary).toContain('already stopped');
  });

  it('reads a server once however many of its sessions the check covers', async () => {
    await dryRun({ definition: definitionOf(), sessions: [movie, episode], user: owner });

    expect(reads.servers).toBe(1);
  });

  it('reports a draft scoped to another account as one that would not run', async () => {
    const definition = definitionOf({ serverUserId: 'su2' });

    const { samples } = await dryRun({ definition, sessions: [movie], user: owner });

    expect(samples[0]?.wouldRun).toBe(false);
    expect(samples[0]?.summary).toContain('scoped elsewhere');
    expect(samples[0]?.conditions).toEqual([]);
    expect(samples[0]?.actions).toEqual([]);
  });

  it('skips a session whose account row is gone', async () => {
    serverUserRows = [];

    const { samples } = await dryRun({
      definition: definitionOf(),
      sessions: [movie],
      user: owner,
    });

    expect(samples).toEqual([]);
  });

  it('drops sessions on servers the caller cannot see and caps the rest', async () => {
    const viewer: AuthUser = {
      userId: 'auth2',
      username: 'viewer',
      role: 'viewer',
      serverIds: ['srv1'],
    };
    const elsewhere = { ...session('sess-other', 'movie'), serverId: 'srv2' };
    const many = Array.from({ length: DRY_RUN_SESSION_CAP + 5 }, (_, index) =>
      session(`sess-${String(index)}`, 'movie')
    );

    const { samples } = await dryRun({
      definition: definitionOf(),
      sessions: [elsewhere, ...many],
      user: viewer,
    });

    expect(samples).toHaveLength(DRY_RUN_SESSION_CAP);
    expect(samples.every((sample) => sample.subject.sessionId !== 'sess-other')).toBe(true);
  });

  it('matches what evaluateRulesAsync reports for the same inputs', async () => {
    const definition = definitionOf();
    const automation: EngineAutomation = toEngineAutomation(definition);

    const { samples } = await dryRun({
      definition,
      sessions: [movie, episode],
      user: owner,
    });

    for (const subject of [movie, episode] as Session[]) {
      const loaded = await loadEvaluationContext(subject.serverId, subject.serverUserId, [
        automation,
      ]);
      if (!loaded) throw new Error('the context assembler found nothing');
      const { baseContext } = triggerCandidates(
        {
          type: 'session.started',
          at: new Date(),
          server: loaded.server,
          serverUser: loaded.serverUser,
          session: subject,
        },
        loaded.inputs,
        subject.id
      );
      const [result] = await evaluateRulesAsync(baseContext, [automation], {
        includeUnmatched: true,
      });
      const sample = samples.find((entry) => entry.subject.sessionId === subject.id);
      expect(sample).toBeDefined();
      expect(sample?.wouldRun).toBe(result?.matched);
    }
  });
});
