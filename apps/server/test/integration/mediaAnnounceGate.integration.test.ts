/**
 * The notification gate for a media subject, which only a real database answers:
 * the run rows carry `media:<libraryItemId>` as their subject and the after-signature
 * as their edge, so a resync that changes nothing records nothing.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaAnnounceGate
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { automations, automationRuns } from '../../src/db/schema.js';
import {
  getActiveAutomations,
  invalidateAutomationsCache,
} from '../../src/jobs/poller/database.js';
import {
  dispatch,
  resetDispatcherForTests,
} from '../../src/services/automations/events/dispatcher.js';
import {
  registerRuleSubscribers,
  resetRuleSubscribersForTests,
} from '../../src/services/automations/events/subscribers.js';
import type { EvaluationInputs } from '../../src/services/automations/events/types.js';
import type { MediaQuality, MediaSubject } from '../../src/services/automations/types.js';

const ADDED_NODE = '7c1d2e3f-4a5b-4c6d-8e9f-000000000001';
const UPGRADED_NODE = '7c1d2e3f-4a5b-4c6d-8e9f-000000000002';

const quality = (overrides: Partial<MediaQuality> = {}): MediaQuality => ({
  resolution: '1080p',
  dynamicRange: 'sdr',
  videoCodec: 'H264',
  audioCodec: 'AC3',
  audioChannels: 6,
  fileSize: 8_000_000_000,
  ...overrides,
});

const subject = (libraryItemId: string, to = quality()): MediaSubject => ({
  libraryItemId,
  title: 'Cars',
  type: 'movie',
  year: 2006,
  libraryId: '1',
  libraryName: 'Movies',
  quality: to,
});

async function listeningAutomation() {
  const [row] = await db
    .insert(automations)
    .values({
      name: 'library announcements',
      kind: 'notification',
      isActive: true,
      conditions: { groups: [] },
      actions: { actions: [] },
      triggers: [
        { id: ADDED_NODE, type: 'media.added', enabled: true },
        { id: UPGRADED_NODE, type: 'media.upgraded', enabled: true },
      ],
    })
    .returning();
  if (!row) throw new Error('failed to insert the listening automation');

  invalidateAutomationsCache();
  const rules = (await getActiveAutomations()).filter((rule) => rule.id === row.id);
  const inputs: EvaluationInputs = {
    activeAutomations: rules,
    activeSessions: [],
    recentSessions: [],
  };
  return { id: row.id, inputs };
}

const runsFor = (automationId: string) =>
  db
    .select({ subjectKey: automationRuns.subjectKey, data: automationRuns.data })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId));

describe('the media notification gate', () => {
  it('records one run per copy added and nothing on the sync after it', async () => {
    const server = await createTestServer({ type: 'plex' });
    const automation = await listeningAutomation();
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    const event = {
      type: 'media.added' as const,
      at: new Date(),
      server: { id: server.id, name: server.name, type: 'plex' as const },
      media: subject('item-added-1'),
    };

    await dispatch(event, automation.inputs);
    await dispatch({ ...event, at: new Date() }, automation.inputs);

    const runs = await runsFor(automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.subjectKey).toBe('media:item-added-1');
    expect((runs[0]?.data as { edgeKey: string | null }).edgeKey).toBeNull();
  });

  it('records one run per distinct quality, so a resync of the same copy repeats nothing', async () => {
    const server = await createTestServer({ type: 'plex' });
    const automation = await listeningAutomation();
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    const upgrade = (to: MediaQuality) => ({
      type: 'media.upgraded' as const,
      at: new Date(),
      server: { id: server.id, name: server.name, type: 'plex' as const },
      media: subject('item-upgraded-1', to),
      from: quality(),
      changed: ['resolution'] as (keyof MediaQuality)[],
    });
    const to4k = quality({ resolution: '4k' });

    await dispatch(upgrade(to4k), automation.inputs);
    await dispatch(upgrade(to4k), automation.inputs);
    await dispatch(upgrade(quality({ resolution: '4k', audioChannels: 8 })), automation.inputs);

    const runs = await runsFor(automation.id);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.subjectKey))).toEqual(new Set(['media:item-upgraded-1']));
    expect(runs.map((run) => (run.data as { edgeKey: string | null }).edgeKey).sort()).toEqual([
      '4k|sdr|H264|AC3|6|8000000000',
      '4k|sdr|H264|AC3|8|8000000000',
    ]);
  });
});
