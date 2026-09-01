/** Real i18n: every line here interpolates, so echoing keys would prove nothing. */
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { Automation, AutomationTemplateRef } from '@tracearr/shared';
import { ProvenanceLine } from './ProvenanceLine';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const template = (overrides: Partial<AutomationTemplateRef> = {}): AutomationTemplateRef => ({
  id: 't-1',
  slug: 'made-up-slug',
  name: 'Too many streams',
  version: 2,
  currentVersion: 2,
  source: 'builtin',
  author: null,
  // Midday, so the rendered day is the same either side of the test machine's offset.
  addedAt: '2026-08-01T12:00:00.000Z',
  ...overrides,
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Concurrent cap',
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [],
    conditions: { groups: [] },
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef: null,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ProvenanceLine', () => {
  it('names a built-in template and the version the row sits on', () => {
    render(<ProvenanceLine automation={automation({ template: template() })} />);

    expect(screen.getByText('Built-in · Too many streams v2')).toBeInTheDocument();
  });

  it('names who signed an import and when it was pasted', () => {
    render(
      <ProvenanceLine
        automation={automation({ template: template({ source: 'import', author: 'ada' }) })}
      />
    );

    expect(
      screen.getByText('Imported from a share code by ada on Aug 1, 2026 · Too many streams v2')
    ).toBeInTheDocument();
  });

  it('leaves an unsigned import unattributed', () => {
    render(
      <ProvenanceLine automation={automation({ template: template({ source: 'import' }) })} />
    );

    expect(
      screen.getByText('Imported from a share code on Aug 1, 2026 · Too many streams v2')
    ).toBeInTheDocument();
  });

  it('says what a locally saved template was saved from, and when', () => {
    render(<ProvenanceLine automation={automation({ template: template({ source: 'local' }) })} />);

    expect(
      screen.getByText('Saved here from Too many streams on Aug 1, 2026 · v2')
    ).toBeInTheDocument();
  });

  it('names the template a detached row left', () => {
    render(
      <ProvenanceLine
        automation={automation({
          origin: { templateId: 't-1', version: 1, name: 'Too many streams' },
        })}
      />
    );

    expect(screen.getByText('Customized from Too many streams')).toBeInTheDocument();
  });

  it('says so when that template is gone', () => {
    render(
      <ProvenanceLine
        automation={automation({ origin: { templateId: 't-1', version: 1, name: null } })}
      />
    );

    expect(
      screen.getByText('Customized from a ready-made automation that has since been removed')
    ).toBeInTheDocument();
  });

  it('says nothing about a row that came from nowhere', () => {
    const { container } = render(<ProvenanceLine automation={automation()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
