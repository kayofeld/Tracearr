/** Real i18n: the accessible name is one of the filter's four source words. */
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { AutomationTemplateRef } from '@tracearr/shared';
import { TemplateBadge } from './TemplateBadge';

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
  addedAt: '2026-08-01T12:00:00.000Z',
  ...overrides,
});

const glyph = (container: HTMLElement) => container.querySelector('svg')?.getAttribute('class');

describe('TemplateBadge', () => {
  it('names the template and says where it came from, for a reader who cannot see the glyph', () => {
    render(<TemplateBadge template={template({ source: 'import' })} />);

    expect(screen.getByText('Too many streams')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toHaveClass('sr-only');
  });

  it('gives each source its own glyph', () => {
    const { container, rerender } = render(<TemplateBadge template={template()} />);
    const builtin = glyph(container);

    rerender(<TemplateBadge template={template({ source: 'import' })} />);
    const imported = glyph(container);

    rerender(<TemplateBadge template={template({ source: 'local' })} />);

    expect(new Set([builtin, imported, glyph(container)]).size).toBe(3);
  });

  it('marks a row whose template has moved on', () => {
    render(<TemplateBadge template={template({ version: 1, currentVersion: 3 })} />);

    expect(screen.getByLabelText('An update is available')).toBeInTheDocument();
  });

  it('drops the chip when the line around it is muted already', () => {
    const { container } = render(<TemplateBadge template={template()} plain />);

    expect(container.firstElementChild?.className).not.toContain('rounded-full');
    expect(screen.getByText('Too many streams')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toHaveClass('sr-only');
  });
});
