import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state';

function emptyElement() {
  return screen.getByText('Nothing here').closest('[data-slot="empty"]');
}

describe('EmptyState', () => {
  it('keeps its vertical padding at md and up while capping the horizontal', () => {
    render(<EmptyState title="Nothing here" />);

    const empty = emptyElement();
    expect(empty).toHaveClass('py-12', 'md:px-6', 'md:py-12');
    // A bare md:p-* would land after py-12 in the sheet and flatten the block padding.
    expect(empty).not.toHaveClass('md:p-6');
  });

  it('lets a consumer trade the base padding down', () => {
    render(<EmptyState title="Nothing here" className="py-6" />);

    const empty = emptyElement();
    expect(empty).toHaveClass('py-6');
    expect(empty).not.toHaveClass('py-12');
  });
});
