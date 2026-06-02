import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Server } from '@tracearr/shared';
import { ServerLegend } from './ServerLegend';

function s(id: string, name: string, color: string | null = null): Server {
  return {
    id,
    name,
    type: 'plex',
    url: '',
    color,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('ServerLegend', () => {
  it('renders an entry per server in inline variant', () => {
    render(<ServerLegend servers={[s('a', 'Plex', '#E5A00D'), s('b', 'JF', '#AA5CC3')]} />);
    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('JF')).toBeInTheDocument();
  });

  it('labels the container as a server legend group for assistive tech', () => {
    render(<ServerLegend servers={[s('a', 'Plex', '#E5A00D'), s('b', 'JF', '#AA5CC3')]} />);
    expect(screen.getByRole('group', { name: 'Server legend' })).toBeInTheDocument();
  });

  it('renders nothing when fewer than 2 servers are provided', () => {
    const { container } = render(<ServerLegend servers={[s('a', 'Plex', '#E5A00D')]} />);
    expect(container.firstChild).toBeNull();
  });

  it('applies floating layout class when variant="floating"', () => {
    const { container } = render(
      <ServerLegend
        variant="floating"
        servers={[s('a', 'Plex', '#E5A00D'), s('b', 'JF', '#AA5CC3')]}
      />
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/absolute/);
  });

  it('paints each entry with the server color', () => {
    const { container } = render(
      <ServerLegend servers={[s('a', 'Plex', '#E5A00D'), s('b', 'JF', '#AA5CC3')]} />
    );
    const dots = container.querySelectorAll('span[aria-hidden="true"]');
    expect(dots.length).toBe(2);
    expect(dots[0]).toHaveStyle({ backgroundColor: '#E5A00D' });
    expect(dots[1]).toHaveStyle({ backgroundColor: '#AA5CC3' });
  });
});
