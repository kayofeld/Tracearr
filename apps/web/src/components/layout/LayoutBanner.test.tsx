import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutBanner } from './LayoutBanner';

function renderBanner(variant: 'warning' | 'destructive' = 'warning') {
  render(<LayoutBanner variant={variant}>strip copy</LayoutBanner>);
  return screen.getByRole('alert');
}

describe('LayoutBanner', () => {
  it('lays the strip out on the Alert grid rather than overriding it with flex', () => {
    const banner = renderBanner();

    // `flex` on the root would collapse the two-column grid the icon and copy
    // are placed into, leaving col-start-2 inert.
    expect(banner).toHaveClass('grid');
    expect(banner).not.toHaveClass('flex');
  });

  it('spans full bleed with only a bottom border', () => {
    const banner = renderBanner();

    expect(banner).toHaveClass('rounded-none', 'border-x-0', 'border-t-0');
  });

  it('carries no leftover overrides from the absolute-icon generation', () => {
    const banner = renderBanner();

    const stale = ['[&>svg]:!top-1/2', '[&>svg]:!-translate-y-1/2', '[&>svg+div]:!translate-y-0'];
    for (const cls of stale) {
      expect(banner.className).not.toContain(cls);
    }
  });

  it('stretches the description so a caller-supplied flex row can justify-between', () => {
    renderBanner();

    const description = document.querySelector('[data-slot="alert-description"]');
    // justify-items-start would shrink the child to max-content and strand a
    // right-aligned dismiss button against the message.
    expect(description).toHaveClass('justify-items-stretch');
  });

  it('tints by variant so the strip reads without relying on a border colour', () => {
    const warning = renderBanner('warning');

    expect(warning).toHaveClass('bg-warning/10');
    expect(warning).toHaveAttribute('data-variant', 'warning');
  });

  it('keeps destructive copy at full strength rather than muted', () => {
    const banner = renderBanner('destructive');

    expect(banner).toHaveClass('bg-destructive/10');
    expect(banner.className).toContain('*:data-[slot=alert-description]:text-destructive');
  });

  it('renders the icon and the copy', () => {
    const banner = renderBanner();

    expect(banner.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('strip copy')).toBeInTheDocument();
  });
});
