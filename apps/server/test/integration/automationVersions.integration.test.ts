/**
 * Automation version integration tests
 *
 * Three things a mocked driver cannot answer: the next version number is computed
 * inside the insert statement, the rules cache reads the latest version through a
 * correlated subquery, and automation_runs.definition_version_id references a table
 * that cascades from the same delete.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- automationVersions
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { automations, automationRuns, automationVersions } from '../../src/db/schema.js';
import {
  getActiveAutomations,
  invalidateAutomationsCache,
} from '../../src/jobs/poller/database.js';
import {
  automationDefinition,
  insertAutomationVersion,
} from '../../src/services/automations/versions.js';

async function seedAutomation(name: string) {
  const [row] = await db
    .insert(automations)
    .values({
      name,
      conditions: { groups: [] },
      actions: { actions: [] },
      triggers: [],
    })
    .returning();
  if (!row) throw new Error(`failed to insert ${name}`);
  return row;
}

describe('automation versions', () => {
  it('numbers each automation from one and hands the cache the latest', async () => {
    const first = await seedAutomation('versioned');
    const other = await seedAutomation('untouched');

    const v1 = await insertAutomationVersion(db, first.id, automationDefinition(first));
    const v2 = await insertAutomationVersion(
      db,
      first.id,
      automationDefinition({ ...first, name: 'versioned again' })
    );
    const otherV1 = await insertAutomationVersion(db, other.id, automationDefinition(other));

    const rows = await db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, first.id));
    expect(rows.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(new Set([v1, v2, otherV1]).size).toBe(3);

    const otherRows = await db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, other.id));
    expect(otherRows[0]?.version).toBe(1);

    invalidateAutomationsCache();
    const cached = await getActiveAutomations();
    expect(cached.find((rule) => rule.id === first.id)?.currentVersionId).toBe(v2);
    expect(cached.find((rule) => rule.id === other.id)?.currentVersionId).toBe(otherV1);
  });

  it('drops versions and the runs pointing at them when the automation goes', async () => {
    const automation = await seedAutomation('doomed');
    const versionId = await insertAutomationVersion(
      db,
      automation.id,
      automationDefinition(automation)
    );

    await db.insert(automationRuns).values({
      automationId: automation.id,
      serverUserId: null,
      sessionId: null,
      data: {},
      definitionVersionId: versionId ?? null,
      subjectKey: 'account',
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    await db.delete(automations).where(eq(automations.id, automation.id));

    const runsLeft = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automation.id));
    const versionsLeft = await db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, automation.id));
    expect(runsLeft).toEqual([]);
    expect(versionsLeft).toEqual([]);
  });
});
