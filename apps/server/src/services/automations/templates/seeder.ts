/**
 * Boot pass for the bundled templates: upsert by slug, append a version when the
 * body changed, then carry the instances whose bindings still fit onto it.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import {
  canonicalJson,
  materializeTemplate,
  type CreateAutomationInput,
  type TemplateEnvelope,
  type TemplateInput,
} from '@tracearr/shared';
import { db, type Executor } from '../../../db/client.js';
import {
  automations,
  automationTemplates,
  automationTemplateVersions,
} from '../../../db/schema.js';
import { invalidateAutomationsCache } from '../../../jobs/poller/database.js';
import { createLogger } from '../../../utils/logger.js';
import { automationDefinition, insertAutomationVersion } from '../versions.js';
import { BUILTIN_ENVELOPES } from './builtin/index.js';

const logger = createLogger('template-seeder');

/** Distinct from destinations' 875_100_003 and the automation model's 875_100_004. */
const LOCK_KEY = 875_100_005;

export interface SeedCounts {
  inserted: number;
  versioned: number;
  upgraded: number;
}

/** Two input sets match when the same keys carry the same kinds, whatever their order. */
const inputSignature = (inputs: TemplateInput[]): string =>
  canonicalJson([...inputs].map((input) => [input.key, input.kind]).sort());

/**
 * Instances the new version can take over: their bindings still name the same
 * inputs, and what they bind still materializes into a valid automation.
 */
async function upgradeInstances(
  tx: Executor,
  template: { id: string; slug: string },
  version: { version: number; inputs: TemplateInput[]; definition: TemplateEnvelope['definition'] }
): Promise<number> {
  const bound = await tx
    .select()
    .from(automations)
    .where(
      and(eq(automations.templateId, template.id), lt(automations.templateVersion, version.version))
    );
  if (bound.length === 0) return 0;

  const signatures = new Map<number, string>();
  for (const row of await tx
    .select({
      version: automationTemplateVersions.version,
      inputs: automationTemplateVersions.inputs,
    })
    .from(automationTemplateVersions)
    .where(eq(automationTemplateVersions.templateId, template.id))) {
    signatures.set(row.version, inputSignature(row.inputs));
  }
  const target = inputSignature(version.inputs);

  let upgraded = 0;
  for (const row of bound) {
    if (row.templateVersion === null || signatures.get(row.templateVersion) !== target) continue;
    let created: CreateAutomationInput;
    try {
      created = materializeTemplate(version, row.templateInputs ?? {}, { name: row.name });
    } catch (err) {
      // A binding the new version cannot satisfy: the instance waits for the review path.
      logger.debug(`${template.slug} v${version.version} does not fit automation ${row.id}`, {
        err,
      });
      continue;
    }
    const [updated] = await tx
      .update(automations)
      .set({
        // Both follow the new version: a kind it moved, and a reach it dropped.
        kind: created.kind,
        triggers: created.triggers,
        conditions: created.conditions,
        actions: created.actions,
        serverId: created.serverId ?? null,
        serverUserId: created.serverUserId ?? null,
        userId: created.userId ?? null,
        enforceAcrossServers: created.enforceAcrossServers ?? false,
        templateVersion: version.version,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, row.id))
      .returning();
    if (!updated) continue;
    await insertAutomationVersion(tx, updated.id, automationDefinition(updated));
    upgraded += 1;
  }
  return upgraded;
}

/**
 * Runs on every boot inside one transaction. Idempotent by fingerprint: an
 * unchanged catalog writes nothing, and nothing here ever deletes a row.
 */
export async function seedBuiltinTemplates(
  envelopes: TemplateEnvelope[] = BUILTIN_ENVELOPES
): Promise<SeedCounts> {
  const counts = await db.transaction(async (tx): Promise<SeedCounts> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const summary: SeedCounts = { inserted: 0, versioned: 0, upgraded: 0 };

    for (const envelope of envelopes) {
      const fields = {
        name: envelope.name,
        description: envelope.description,
        group: envelope.group,
        kind: envelope.kind,
        minServerVersion: envelope.minServerVersion,
      };
      const existing = (
        await tx
          .select()
          .from(automationTemplates)
          .where(eq(automationTemplates.slug, envelope.slug))
      )[0];

      if (!existing) {
        const inserted = await tx
          .insert(automationTemplates)
          .values({
            ...fields,
            slug: envelope.slug,
            author: envelope.author ?? null,
            builtin: true,
            source: 'builtin',
            currentVersion: 1,
            fingerprint: envelope.fingerprint,
          })
          .returning({ id: automationTemplates.id });
        const row = inserted[0];
        if (!row) throw new Error(`failed to seed template ${envelope.slug}`);
        await tx.insert(automationTemplateVersions).values({
          templateId: row.id,
          version: 1,
          inputs: envelope.inputs,
          definition: envelope.definition,
          fingerprint: envelope.fingerprint,
        });
        summary.inserted += 1;
        continue;
      }

      const changed = existing.fingerprint !== envelope.fingerprint;
      const version = changed ? existing.currentVersion + 1 : existing.currentVersion;
      if (changed) {
        await tx.insert(automationTemplateVersions).values({
          templateId: existing.id,
          version,
          inputs: envelope.inputs,
          definition: envelope.definition,
          fingerprint: envelope.fingerprint,
        });
        summary.versioned += 1;
      }

      // The fingerprint covers inputs and definition only, so the metadata is compared
      // field by field; a boot that moves neither leaves updated_at alone.
      const restated = (Object.keys(fields) as (keyof typeof fields)[]).some(
        (key) => existing[key] !== fields[key]
      );
      if (changed || restated) {
        await tx
          .update(automationTemplates)
          .set({
            ...fields,
            builtin: true,
            source: 'builtin',
            currentVersion: version,
            fingerprint: envelope.fingerprint,
            updatedAt: new Date(),
          })
          .where(eq(automationTemplates.id, existing.id));
      }
      if (changed) {
        summary.upgraded += await upgradeInstances(tx, existing, {
          version,
          inputs: envelope.inputs,
          definition: envelope.definition,
        });
      }
    }

    return summary;
  });

  if (counts.inserted + counts.versioned + counts.upgraded > 0) {
    invalidateAutomationsCache();
    logger.info(
      `Seeded ${counts.inserted} template(s), versioned ${counts.versioned} and upgraded ${counts.upgraded} instance(s)`
    );
  }
  return counts;
}
