/**
 * The template store against real rows: slug collisions, version appends, the
 * delete guard's counts, and the columns an instantiated automation carries.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- templateStore
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fingerprintOf, templateEnvelopeSchema, type TemplateEnvelope } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { automationTemplates, automationVersions, servers } from '../../src/db/schema.js';
import { BUILTIN_ENVELOPES } from '../../src/services/automations/templates/builtin/index.js';
import {
  defaultInstanceName,
  materializeInstance,
} from '../../src/services/automations/templates/materialize.js';
import { seedBuiltinTemplates } from '../../src/services/automations/templates/seeder.js';
import {
  TemplateFingerprintError,
  createTemplate,
  deleteTemplate,
  getTemplate,
  getTemplateVersion,
  instantiateTemplate,
  listTemplates,
  matchTemplate,
  sha256Hex,
} from '../../src/services/automations/templates/store.js';

const DESTINATION_ID = '8c4a0d31-4f5b-4d0e-9a12-77c6d5b3e401';

const builtin = (slug: string): TemplateEnvelope => {
  const found = BUILTIN_ENVELOPES.find((envelope) => envelope.slug === slug);
  if (!found) throw new Error(`${slug} is missing`);
  return structuredClone(found);
};

const reseal = (envelope: TemplateEnvelope): TemplateEnvelope =>
  templateEnvelopeSchema.parse({ ...envelope, fingerprint: fingerprintOf(envelope, sha256Hex) });

/** Same slug, different body: what a second import of an edited share code looks like. */
function variant(slug: string, title: string): TemplateEnvelope {
  const envelope = builtin(slug);
  const [action] = envelope.definition.actions.actions;
  if (action?.type !== 'send') throw new Error(`${slug} lost its send action`);
  action.title = title;
  return reseal(envelope);
}

const imported = { source: 'import' } as const;

/** What the instantiate route does: name it, bind it, then store the binding. */
async function instantiate(
  templateId: string,
  inputs: Record<string, unknown>,
  options: { name?: string } & Parameters<typeof instantiateTemplate>[3] = {}
) {
  const { name, ...overrides } = options;
  const template = await getTemplate(templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  const bound = materializeInstance(
    template.version,
    inputs,
    name ?? (await defaultInstanceName(db, template.name, template.version, inputs))
  );
  if (!bound.ok) throw new Error(bound.reason);
  return db.transaction((tx) =>
    instantiateTemplate(tx, template, { definition: bound.definition, inputs }, overrides)
  );
}

describe('template store', () => {
  describe('createTemplate', () => {
    it('stores a new envelope and hands the same one back on a second import', async () => {
      const envelope = builtin('stream-started');

      const first = await createTemplate(envelope, imported);
      const second = await createTemplate(envelope, imported);

      expect(first).toEqual({ id: first.id, version: 1, created: true });
      expect(second).toEqual({ id: first.id, version: 1, created: false });
      const rows = await db.select().from(automationTemplates);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ builtin: false, source: 'import', currentVersion: 1 });
    });

    it('suffixes the slug when a different body claims it', async () => {
      await createTemplate(builtin('stream-started'), imported);

      const second = await createTemplate(variant('stream-started', 'Now playing'), imported);
      const third = await createTemplate(variant('stream-started', 'Playing'), imported);

      const slugs = await db.select({ slug: automationTemplates.slug }).from(automationTemplates);
      expect(slugs.map((row) => row.slug).sort()).toEqual([
        'stream-started',
        'stream-started-2',
        'stream-started-3',
      ]);
      expect(second.created && third.created).toBe(true);
    });

    it('never lets an import land on a builtin slug', async () => {
      await seedBuiltinTemplates([builtin('stream-started')]);

      const created = await createTemplate(variant('stream-started', 'Now playing'), imported);

      const rows = await db
        .select()
        .from(automationTemplates)
        .where(eq(automationTemplates.id, created.id));
      expect(rows[0]?.slug).toBe('stream-started-2');
      expect(rows[0]?.builtin).toBe(false);
    });

    it('appends a version when the import replaces one the user owns', async () => {
      const original = await createTemplate(builtin('stream-started'), imported);
      const edited = variant('stream-started', 'Now playing');

      const replaced = await createTemplate(edited, { source: 'local', replaceId: original.id });

      expect(replaced).toEqual({ id: original.id, version: 2, created: false });
      const rows = await db
        .select()
        .from(automationTemplates)
        .where(eq(automationTemplates.id, original.id));
      expect(rows[0]).toMatchObject({ currentVersion: 2, fingerprint: edited.fingerprint });
      expect(await getTemplateVersion(original.id, 1)).not.toBeNull();
    });

    it('ignores a replace that names a template under another slug', async () => {
      const other = await createTemplate(builtin('stream-ended'), imported);
      const edited = variant('stream-started', 'Now playing');

      const result = await createTemplate(edited, { source: 'import', replaceId: other.id });

      expect(result.created).toBe(true);
      expect(result.id).not.toBe(other.id);
      const rows = await db
        .select()
        .from(automationTemplates)
        .where(eq(automationTemplates.id, other.id));
      expect(rows[0]).toMatchObject({ slug: 'stream-ended', currentVersion: 1 });
    });

    it('rejects an envelope whose fingerprint does not match its body', async () => {
      const envelope = builtin('stream-started');
      const tampered = { ...envelope, fingerprint: 'f'.repeat(64) };

      await expect(createTemplate(tampered, imported)).rejects.toBeInstanceOf(
        TemplateFingerprintError
      );
      expect(await db.select().from(automationTemplates)).toHaveLength(0);
    });
  });

  describe('matchTemplate', () => {
    it('prefers the row with the same body over the one with the same slug', async () => {
      const original = await createTemplate(builtin('stream-started'), imported);
      const edited = variant('stream-started', 'Now playing');
      const renamed = await createTemplate(
        templateEnvelopeSchema.parse({ ...edited, slug: 'now-playing' }),
        imported
      );

      const bySlug = await matchTemplate(edited);
      const byBody = await matchTemplate({ ...edited, slug: 'anything-else' });

      expect(bySlug).toMatchObject({ templateId: renamed.id, fingerprintMatch: true });
      expect(byBody).toMatchObject({ templateId: renamed.id, fingerprintMatch: true });
      expect(await matchTemplate({ slug: 'stream-started', fingerprint: 'f'.repeat(64) })).toEqual({
        templateId: original.id,
        version: 1,
        name: 'Stream started',
        builtin: false,
        fingerprintMatch: false,
      });
    });

    it('lands an import on the same body under another slug', async () => {
      const envelope = builtin('stream-started');
      const first = await createTemplate(
        templateEnvelopeSchema.parse({ ...envelope, slug: 'renamed-elsewhere' }),
        imported
      );

      const second = await createTemplate(envelope, imported);

      expect(second).toEqual({ id: first.id, version: 1, created: false });
      expect(await db.select().from(automationTemplates)).toHaveLength(1);
    });

    it('finds nothing when neither the slug nor the body is stored', async () => {
      expect(await matchTemplate(builtin('stream-started'))).toBeNull();
    });
  });

  describe('reads', () => {
    it('counts the automations bound to each template', async () => {
      await seedBuiltinTemplates([builtin('stream-started'), builtin('stream-ended')]);
      const started = await createTemplate(variant('paused-too-long', 'x'), imported);
      const rows = await db.select().from(automationTemplates);
      const streamStarted = rows.find((row) => row.slug === 'stream-started');
      if (!streamStarted) throw new Error('stream-started was not seeded');
      await instantiate(streamStarted.id, { to: [DESTINATION_ID] });
      await instantiate(streamStarted.id, { to: [DESTINATION_ID] });

      const listed = await listTemplates();

      expect(listed).toHaveLength(3);
      expect(listed.find((row) => row.id === streamStarted.id)?.usedBy).toBe(2);
      expect(listed.find((row) => row.id === started.id)?.usedBy).toBe(0);
    });

    it('returns the current version with the template and older ones by number', async () => {
      const created = await createTemplate(builtin('stream-started'), imported);
      await createTemplate(variant('stream-started', 'Now playing'), {
        source: 'import',
        replaceId: created.id,
      });

      const template = await getTemplate(created.id);
      const first = await getTemplateVersion(created.id, 1);

      expect(template?.version.version).toBe(2);
      expect(template?.currentVersion).toBe(2);
      expect(template?.version.inputs.map((input) => input.key)).toEqual(['server', 'to']);
      expect(first?.definition.actions.actions[0]).not.toHaveProperty('title');
      expect(await getTemplate('0e3d3ba2-9d6e-4a0d-8c47-9f3d5a5a2c11')).toBeNull();
      expect(await getTemplateVersion(created.id, 9)).toBeNull();
    });
  });

  describe('deleteTemplate', () => {
    it('refuses a builtin', async () => {
      await seedBuiltinTemplates([builtin('stream-started')]);
      const rows = await db.select().from(automationTemplates);
      const id = rows[0]?.id;
      if (!id) throw new Error('stream-started was not seeded');

      expect(await deleteTemplate(id)).toBe('builtin');
      expect(await db.select().from(automationTemplates)).toHaveLength(1);
    });

    it('names what still uses it', async () => {
      const created = await createTemplate(builtin('stream-started'), imported);
      await instantiate(created.id, { to: [DESTINATION_ID] }, { name: 'Kitchen TV' });

      const result = await deleteTemplate(created.id);

      expect(result).toEqual({ usedBy: 1, names: ['Kitchen TV'] });
      expect(await db.select().from(automationTemplates)).toHaveLength(1);
    });

    it('drops a template nothing points at', async () => {
      const created = await createTemplate(builtin('stream-started'), imported);

      expect(await deleteTemplate(created.id)).toBe('deleted');
      expect(await db.select().from(automationTemplates)).toHaveLength(0);
    });
  });

  describe('instantiateTemplate', () => {
    it('stamps the template columns and writes a first version', async () => {
      const created = await createTemplate(builtin('stream-started'), imported);

      const row = await instantiate(created.id, { to: [DESTINATION_ID] }, { severity: 'high' });

      expect(row).toMatchObject({
        name: 'Stream started',
        templateId: created.id,
        templateVersion: 1,
        templateInputs: { to: [DESTINATION_ID] },
        severity: 'high',
        serverId: null,
      });
      expect(row.triggers?.[0]?.type).toBe('session.started');
      expect(
        await db
          .select()
          .from(automationVersions)
          .where(eq(automationVersions.automationId, row.id))
      ).toHaveLength(1);
    });

    it('names the instance after the server it is bound to', async () => {
      const inserted = await db
        .insert(servers)
        .values({ name: 'Attic', type: 'plex', url: 'http://localhost:32400', token: 'x' })
        .returning();
      const server = inserted[0];
      if (!server) throw new Error('failed to insert the server');
      const created = await createTemplate(builtin('stream-started'), imported);

      const bound = await instantiate(created.id, { server: server.id, to: [DESTINATION_ID] });
      const named = await instantiate(
        created.id,
        { server: server.id, to: [DESTINATION_ID] },
        { name: 'My own name' }
      );

      expect(bound.name).toBe('Stream started — Attic');
      expect(bound.serverId).toBe(server.id);
      expect(named.name).toBe('My own name');
    });

    it('keeps a long server name inside the name column', async () => {
      const inserted = await db
        .insert(servers)
        .values({
          name: 'A'.repeat(100),
          type: 'plex',
          url: 'http://localhost:32401',
          token: 'x',
        })
        .returning();
      const server = inserted[0];
      if (!server) throw new Error('failed to insert the server');
      const created = await createTemplate(builtin('stream-started'), imported);

      const row = await instantiate(created.id, { server: server.id, to: [DESTINATION_ID] });

      expect(row.name).toHaveLength(100);
      expect(row.name.startsWith('Stream started — AAA')).toBe(true);
    });

    it('lists the required inputs a caller left unbound', async () => {
      const created = await createTemplate(builtin('geo-restriction'), imported);
      const template = await getTemplate(created.id);
      if (!template) throw new Error('no template');

      const bound = materializeInstance(template.version, {}, 'Blocked countries');

      expect(bound).toEqual({ ok: false, reason: expect.stringContaining('countries') });
    });

    it('names an input the version never declared', async () => {
      const created = await createTemplate(builtin('stream-started'), imported);
      const template = await getTemplate(created.id);
      if (!template) throw new Error('no template');

      const bound = materializeInstance(
        template.version,
        { to: [DESTINATION_ID], nope: 1 },
        'Stream started'
      );

      expect(bound).toEqual({ ok: false, reason: 'Unknown input(s): nope' });
    });
  });
});
