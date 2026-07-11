/**
 * Bandwidth weighted-average consistency integration tests.
 *
 * GET /bandwidth/summary is the KPI card shown next to the GET /bandwidth/daily
 * chart. Both must agree on "average bitrate": weighted by session count, not a
 * naive average of per-day averages. Confirms the summary route's avg_bitrate
 * reconstructs the same value you'd get by combining the daily chart's rows.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- bandwidthWeightedAverage
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { bandwidthRoutes } from '../../src/routes/stats/bandwidth.js';

function ownerAuth() {
  return { userId: 'owner', username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: unknown }) => {
    request.user = ownerAuth();
  });
  await app.register(bandwidthRoutes as never);
  return app;
}

describe('bandwidth weighted average consistency', () => {
  it('summary avg bitrate equals the session-weighted combination of the daily rows', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    // Day 1: one high-bitrate session. Day 2: three low-bitrate sessions.
    // Naive average-of-days would be (100000 + 10000) / 2 = 55000.
    // Session-weighted average is (1*100000 + 3*10000) / 4 = 32500.
    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      startedAt: new Date('2024-01-10T12:00:00Z'),
      durationMs: 600_000,
      bitrate: 100_000,
    });
    for (let i = 0; i < 3; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: serverUser.id,
        startedAt: new Date('2024-01-11T12:00:00Z'),
        durationMs: 600_000,
        bitrate: 10_000,
      });
    }

    const app = await buildApp();

    const dailyResponse = await app.inject({
      method: 'GET',
      url: `/bandwidth/daily?period=all&serverId=${server.id}`,
    });
    const summaryResponse = await app.inject({
      method: 'GET',
      url: `/bandwidth/summary?period=all&serverId=${server.id}`,
    });
    await app.close();

    expect(dailyResponse.statusCode).toBe(200);
    const dailyRows = dailyResponse.json().data as {
      sessions: number;
      avgBitrate: number;
    }[];
    expect(dailyRows).toHaveLength(2);

    // Reconstruct the session-weighted average directly from the chart's own rows.
    const totalSessions = dailyRows.reduce((sum, r) => sum + r.sessions, 0);
    const weightedSum = dailyRows.reduce((sum, r) => sum + r.avgBitrate * r.sessions, 0);
    const expectedWeightedAvg = Math.round(weightedSum / totalSessions);

    expect(totalSessions).toBe(4);
    expect(expectedWeightedAvg).toBe(32_500);

    expect(summaryResponse.statusCode).toBe(200);
    const summaryBody = summaryResponse.json();
    expect(summaryBody.avgBitrate).toBe(expectedWeightedAvg);
    expect(summaryBody.avgBitrate).not.toBe(55_000);
  });
});
