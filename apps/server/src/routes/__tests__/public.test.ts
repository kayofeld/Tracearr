/**
 * Public API v1 contract tests
 *
 * `/api/v1/public` is frozen: third-party integrations read these payloads, so a
 * renamed, added or dropped key is a break. Every key is spelled out here rather
 * than matched loosely, and the assertions run against the serialized response,
 * not the handler's return value.
 *
 * The violation endpoints read `automation_runs`, which also holds notification
 * runs and runs that stopped or errored, so each query's WHERE is rendered and
 * checked for the alias filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { queryChain, renderCall, renderSql } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(() => null),
}));

vi.mock('../stats/queries.js', () => ({
  queryPlaysOverTime: vi.fn(async () => []),
  queryConcurrentStreams: vi.fn(async () => []),
  queryPlaysByDayOfWeek: vi.fn(async () => []),
  queryPlaysByHourOfDay: vi.fn(async () => []),
  queryPlatforms: vi.fn(async () => []),
  queryQualityBreakdown: vi.fn(async () => []),
}));

import { db } from '../../db/client.js';
import { publicRoutes } from '../public.js';

/** Completed policy runs: nothing else is a violation. */
function expectAliasFilter(where: { text: string; params: unknown[] }) {
  expect(where.text).toContain('automation_runs.kind =');
  expect(where.params).toContain('policy');
  expect(where.text).toContain('automation_runs.outcome =');
  expect(where.params).toContain('completed');
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticatePublicApi', async (request: FastifyRequest) => {
    request.publicApiContext = { userId: 'owner-1' };
  });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  return app;
}

describe('GET /api/v1/public/violations', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  const serverId = randomUUID();
  const ruleId = randomUUID();
  const userId = randomUUID();
  const violationId = randomUUID();

  function enrichedRow() {
    return {
      id: violationId,
      serverId,
      serverName: 'Living Room Plex',
      severity: 'high',
      acknowledgedAt: null,
      data: { maxStreams: 2, actualStreams: 4 },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      ruleId,
      ruleType: null,
      ruleName: 'Max 2 concurrent streams',
      userId,
      serverUsername: 'ada_plex',
      thumbUrl: 'https://plex.tv/users/ada/avatar',
      userName: 'Ada Lovelace',
      userUsername: 'ada',
    };
  }

  it('serializes one enriched row with exactly the documented keys', async () => {
    app = await buildTestApp();
    vi.mocked((db as any).select)
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 1 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [enrichedRow()]));

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/violations' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          id: violationId,
          serverId,
          serverName: 'Living Room Plex',
          severity: 'high',
          acknowledged: false,
          data: { maxStreams: 2, actualStreams: 4 },
          createdAt: '2026-01-02T03:04:05.000Z',
          rule: {
            id: ruleId,
            type: null,
            name: 'Max 2 concurrent streams',
          },
          user: {
            id: userId,
            username: 'Ada Lovelace',
            thumbUrl: 'https://plex.tv/users/ada/avatar',
            avatarUrl: 'https://plex.tv/users/ada/avatar',
          },
        },
      ],
      meta: { total: 1, page: 1, pageSize: 25 },
    });
  });

  it('names every key of the row, its rule, its user and the envelope', async () => {
    app = await buildTestApp();
    vi.mocked((db as any).select)
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 1 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [enrichedRow()]));

    const body = await app
      .inject({ method: 'GET', url: '/api/v1/public/violations' })
      .then((r) => r.json());

    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    expect(Object.keys(body.meta).sort()).toEqual(['page', 'pageSize', 'total']);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'acknowledged',
      'createdAt',
      'data',
      'id',
      'rule',
      'serverId',
      'serverName',
      'severity',
      'user',
    ]);
    expect(Object.keys(body.data[0].rule).sort()).toEqual(['id', 'name', 'type']);
    expect(Object.keys(body.data[0].user).sort()).toEqual([
      'avatarUrl',
      'id',
      'thumbUrl',
      'username',
    ]);
  });

  it('serves a null rule.type, which V2 automations have always produced', async () => {
    app = await buildTestApp();
    vi.mocked((db as any).select)
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 1 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [{ ...enrichedRow(), ruleType: null }]));

    const body = await app
      .inject({ method: 'GET', url: '/api/v1/public/violations' })
      .then((r) => r.json());

    expect(body.data[0].rule.type).toBeNull();
  });

  it('counts and lists the same alias-filtered rows', async () => {
    app = await buildTestApp();
    const countChain = queryChain(vi.fn, [{ count: 0 }]);
    const rowsChain = queryChain(vi.fn, []);
    vi.mocked((db as any).select)
      .mockReturnValueOnce(countChain)
      .mockReturnValueOnce(rowsChain);

    await app.inject({ method: 'GET', url: '/api/v1/public/violations' });

    const countWhere = renderCall(countChain);
    const rowsWhere = renderCall(rowsChain);
    expectAliasFilter(countWhere);
    expect(countWhere.text).toContain('automation_runs.server_user_id is not null');
    expect(rowsWhere.text).toBe(countWhere.text);
    expect(rowsWhere.params).toEqual(countWhere.params);
  });

  it('keeps the severity, acknowledged and serverId filters working alongside the alias', async () => {
    app = await buildTestApp();
    const countChain = queryChain(vi.fn, [{ count: 0 }]);
    vi.mocked((db as any).select)
      .mockReturnValueOnce(countChain)
      .mockReturnValueOnce(queryChain(vi.fn, []));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/violations?serverId=${serverId}&severity=high&acknowledged=true&page=2&pageSize=5`,
    });

    expect(response.json().meta).toEqual({ total: 0, page: 2, pageSize: 5 });
    const where = renderCall(countChain);
    expect(where.text).toContain('server_users.server_id =');
    expect(where.text).toContain('automation_runs.severity =');
    expect(where.text).toContain('automation_runs.acknowledged_at is not null');
    expect(where.params).toContain(serverId);
    expectAliasFilter(where);
  });
});

describe('GET /api/v1/public/stats', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps its five keys and counts violations under the alias', async () => {
    app = await buildTestApp();
    const violationChain = queryChain(vi.fn, [{ count: 3 }]);
    vi.mocked((db as any).select)
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 7 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 42 }]))
      .mockReturnValueOnce(violationChain);

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/stats' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'activeStreams',
      'recentViolations',
      'timestamp',
      'totalSessions',
      'totalUsers',
    ]);
    expect(body.activeStreams).toBe(0);
    expect(body.totalUsers).toBe(7);
    expect(body.totalSessions).toBe(42);
    expect(body.recentViolations).toBe(3);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);

    expectAliasFilter(renderCall(violationChain));
  });
});

describe('GET /api/v1/public/stats/today', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps its six keys and counts alerts under the alias', async () => {
    app = await buildTestApp();
    vi.mocked((db as any).select)
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 5 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [{ totalMs: 7200000 }]))
      .mockReturnValueOnce(queryChain(vi.fn, [{ count: 2 }]));
    vi.mocked((db as any).execute)
      .mockResolvedValueOnce({ rows: [{ count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ count: 9 }] });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/stats/today?serverId=${randomUUID()}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'activeStreams',
      'activeUsersToday',
      'alertsLast24h',
      'todayPlays',
      'todaySessions',
      'watchTimeHours',
    ]);
    expect(body.alertsLast24h).toBe(4);
    expect(body.todayPlays).toBe(9);
    expect(body.todaySessions).toBe(5);
    expect(body.watchTimeHours).toBe(2);
    expect(body.activeUsersToday).toBe(2);
    expect(body.activeStreams).toBe(0);

    // The alert count is raw SQL over automation_runs aliased v.
    const alertsSql = vi.mocked((db as any).execute).mock.calls[0]?.[0] as SQL;
    const rendered = renderSql(alertsSql).sql.replace(/\s+/g, ' ');
    expect(rendered).toContain("v.kind = 'policy'");
    expect(rendered).toContain("v.outcome = 'completed'");
  });
});

describe('GET /api/v1/public/activity', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps its eight keys, none of which is a violation count', async () => {
    app = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/activity' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'byDayOfWeek',
      'byHourOfDay',
      'concurrent',
      'period',
      'platforms',
      'plays',
      'quality',
      'range',
    ]);
    expect(Object.keys(body.range).sort()).toEqual(['end', 'start']);
    expect(body.period).toBe('month');
  });
});
