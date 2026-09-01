/**
 * Boot seeding for the bundled templates.
 *
 * The interesting parts need real rows: the version number is per template, the
 * second boot has to write nothing at all, and a rewritten envelope carries its
 * bound instances forward only when their bindings still fit.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- templateSeeder
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fingerprintOf, templateEnvelopeSchema, type TemplateEnvelope } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  automations,
  automationTemplates,
  automationTemplateVersions,
  automationVersions,
} from '../../src/db/schema.js';
import { BUILTIN_ENVELOPES } from '../../src/services/automations/templates/builtin/index.js';
import { seedBuiltinTemplates } from '../../src/services/automations/templates/seeder.js';
import { materializeInstance } from '../../src/services/automations/templates/materialize.js';
import {
  getTemplate,
  instantiateTemplate,
  sha256Hex,
} from '../../src/services/automations/templates/store.js';

const DESTINATION_ID = '8c4a0d31-4f5b-4d0e-9a12-77c6d5b3e401';

const streamStarted = (): TemplateEnvelope => {
  const found = BUILTIN_ENVELOPES.find((envelope) => envelope.slug === 'stream-started');
  if (!found) throw new Error('stream-started is missing');
  return structuredClone(found);
};

const pausedTooLong = (): TemplateEnvelope => {
  const found = BUILTIN_ENVELOPES.find((envelope) => envelope.slug === 'paused-too-long');
  if (!found) throw new Error('paused-too-long is missing');
  return structuredClone(found);
};

/** Re-hash after an edit, the way the fingerprint script does before a commit. */
const reseal = (envelope: TemplateEnvelope): TemplateEnvelope =>
  templateEnvelopeSchema.parse({ ...envelope, fingerprint: fingerprintOf(envelope, sha256Hex) });

/** A body-only rewrite: same inputs, so bound instances stay eligible. */
function withTitle(title: string): TemplateEnvelope {
  const envelope = streamStarted();
  const [action] = envelope.definition.actions.actions;
  if (action?.type !== 'send') throw new Error('stream-started lost its send action');
  action.title = title;
  return reseal(envelope);
}

/** A body the bindings still fit on paper but that no longer validates once substituted. */
function withUnknownVariable(): TemplateEnvelope {
  const envelope = streamStarted();
  const [action] = envelope.definition.actions.actions;
  if (action?.type !== 'send') throw new Error('stream-started lost its send action');
  action.title = '{{ nothing.supplies.this }}';
  return reseal(envelope);
}

/** Same keys, different kind: the binding no longer means what the new version asks for. */
function withMinutesAsNumber(): TemplateEnvelope {
  const envelope = pausedTooLong();
  envelope.inputs = envelope.inputs.map((input) =>
    input.key === 'minutes'
      ? { key: 'minutes', kind: 'number', label: 'Minutes paused', required: false, default: 30 }
      : input
  );
  return reseal(envelope);
}

/** A rewrite that moves the kind; the instances on it have to move too. */
function asPolicy(): TemplateEnvelope {
  const envelope = streamStarted();
  envelope.kind = 'policy';
  envelope.definition.kind = 'policy';
  return reseal(envelope);
}

/** A rewrite that asks the user for something new; the review path owns these. */
function withRequiredNote(): TemplateEnvelope {
  const envelope = streamStarted();
  const [action] = envelope.definition.actions.actions;
  if (action?.type !== 'send') throw new Error('stream-started lost its send action');
  action.title = { $input: 'note' };
  envelope.inputs.push({ key: 'note', kind: 'text', label: 'Note', required: true });
  return reseal(envelope);
}

async function templateBySlug(slug: string) {
  const rows = await db
    .select()
    .from(automationTemplates)
    .where(eq(automationTemplates.slug, slug));
  const row = rows[0];
  if (!row) throw new Error(`no template row for ${slug}`);
  return row;
}

async function instantiate(templateId: string, name: string) {
  const template = await getTemplate(templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const inputs = { to: [DESTINATION_ID] };
  const bound = materializeInstance(template.version, inputs, name);
  if (!bound.ok) throw new Error(bound.reason);
  return db.transaction((tx) =>
    instantiateTemplate(tx, template, { definition: bound.definition, inputs }, {})
  );
}

describe('builtin template seeding', () => {
  it('inserts every bundled envelope with a first version', async () => {
    const counts = await seedBuiltinTemplates();

    expect(counts).toEqual({ inserted: BUILTIN_ENVELOPES.length, versioned: 0, upgraded: 0 });
    const templates = await db.select().from(automationTemplates);
    expect(templates).toHaveLength(BUILTIN_ENVELOPES.length);
    expect(templates.every((row) => row.builtin && row.source === 'builtin')).toBe(true);
    expect(templates.every((row) => row.currentVersion === 1)).toBe(true);

    const versions = await db.select().from(automationTemplateVersions);
    expect(versions).toHaveLength(BUILTIN_ENVELOPES.length);
    expect(versions.every((row) => row.version === 1)).toBe(true);
  });

  it('writes nothing on the next boot', async () => {
    await seedBuiltinTemplates();
    const before = await db.select().from(automationTemplates);

    const counts = await seedBuiltinTemplates();

    expect(counts).toEqual({ inserted: 0, versioned: 0, upgraded: 0 });
    const after = await db.select().from(automationTemplates);
    expect(after.map((row) => row.updatedAt.toISOString()).sort()).toEqual(
      before.map((row) => row.updatedAt.toISOString()).sort()
    );
    expect(await db.select().from(automationTemplateVersions)).toHaveLength(
      BUILTIN_ENVELOPES.length
    );
  });

  it('updates the wording without cutting a version', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const renamed = { ...streamStarted(), name: 'Playback started' };

    const counts = await seedBuiltinTemplates([renamed]);

    expect(counts).toEqual({ inserted: 0, versioned: 0, upgraded: 0 });
    const row = await templateBySlug('stream-started');
    expect(row.name).toBe('Playback started');
    expect(row.currentVersion).toBe(1);
  });

  it('appends a version and carries an eligible instance forward', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const template = await templateBySlug('stream-started');
    const instance = await instantiate(template.id, 'Told about starts');

    const counts = await seedBuiltinTemplates([withTitle('Now playing')]);

    expect(counts).toEqual({ inserted: 0, versioned: 1, upgraded: 1 });
    expect((await templateBySlug('stream-started')).currentVersion).toBe(2);
    expect(
      (await db.select().from(automationTemplateVersions)).map((row) => row.version).sort()
    ).toEqual([1, 2]);

    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    const upgraded = rows[0];
    expect(upgraded?.templateVersion).toBe(2);
    expect(upgraded?.name).toBe('Told about starts');
    expect(upgraded?.actions?.actions[0]).toMatchObject({ type: 'send', title: 'Now playing' });
    expect(
      await db
        .select()
        .from(automationVersions)
        .where(eq(automationVersions.automationId, instance.id))
    ).toHaveLength(2);
  });

  it('leaves an instance alone when the new version asks for a new input', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const template = await templateBySlug('stream-started');
    const instance = await instantiate(template.id, 'Told about starts');

    const counts = await seedBuiltinTemplates([withRequiredNote()]);

    expect(counts).toEqual({ inserted: 0, versioned: 1, upgraded: 0 });
    expect((await templateBySlug('stream-started')).currentVersion).toBe(2);

    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    expect(rows[0]?.templateVersion).toBe(1);
    expect(rows[0]?.actions?.actions[0]).not.toHaveProperty('title');
  });

  it('leaves an instance alone when the new body no longer validates', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const template = await templateBySlug('stream-started');
    const instance = await instantiate(template.id, 'Told about starts');

    const counts = await seedBuiltinTemplates([withUnknownVariable()]);

    expect(counts).toEqual({ inserted: 0, versioned: 1, upgraded: 0 });
    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    expect(rows[0]?.templateVersion).toBe(1);
    expect(rows[0]?.actions?.actions[0]).not.toHaveProperty('title');
  });

  it('leaves an instance alone when an input changed kind', async () => {
    await seedBuiltinTemplates([pausedTooLong()]);
    const template = await templateBySlug('paused-too-long');
    const instance = await instantiate(template.id, 'Told about pauses');

    const counts = await seedBuiltinTemplates([withMinutesAsNumber()]);

    expect(counts).toEqual({ inserted: 0, versioned: 1, upgraded: 0 });
    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    expect(rows[0]?.templateVersion).toBe(1);
  });

  it('carries an instance onto the kind and the reach the new version declares', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const template = await templateBySlug('stream-started');
    const instance = await instantiate(template.id, 'Told about starts');
    await db
      .update(automations)
      .set({ enforceAcrossServers: true })
      .where(eq(automations.id, instance.id));

    const counts = await seedBuiltinTemplates([asPolicy()]);

    expect(counts).toEqual({ inserted: 0, versioned: 1, upgraded: 1 });
    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    expect(rows[0]).toMatchObject({ kind: 'policy', enforceAcrossServers: false });
  });

  it('keeps the instance-owned fields through an upgrade', async () => {
    await seedBuiltinTemplates([streamStarted()]);
    const template = await templateBySlug('stream-started');
    const instance = await instantiate(template.id, 'Told about starts');
    await db
      .update(automations)
      .set({ isActive: false, severity: 'high', cooldownMinutes: 15, retentionDays: 7 })
      .where(eq(automations.id, instance.id));

    await seedBuiltinTemplates([withTitle('Now playing')]);

    const rows = await db.select().from(automations).where(eq(automations.id, instance.id));
    expect(rows[0]).toMatchObject({
      isActive: false,
      severity: 'high',
      cooldownMinutes: 15,
      retentionDays: 7,
    });
  });
});
