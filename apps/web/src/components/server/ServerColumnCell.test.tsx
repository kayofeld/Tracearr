import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServerColumnCell } from './ServerColumnCell';

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: vi.fn(),
}));

import { useServerColorMap } from '@/hooks/useServerColorMap';

const mockColorMap = vi.mocked(useServerColorMap);

beforeEach(() => {
  mockColorMap.mockReset();
});

describe('ServerColumnCell', () => {
  it('renders the server name', () => {
    mockColorMap.mockReturnValue(new Map([['srv-a', '#E5A00D']]));
    render(<ServerColumnCell server={{ id: 'srv-a', name: 'My Plex' }} />);
    expect(screen.getByText('My Plex')).toBeInTheDocument();
  });

  it('applies the color from the color map to the dot', () => {
    mockColorMap.mockReturnValue(new Map([['srv-a', '#E5A00D']]));
    const { container } = render(<ServerColumnCell server={{ id: 'srv-a', name: 'My Plex' }} />);
    const dot = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.backgroundColor).toBe('rgb(229, 160, 13)');
  });

  it('renders without a color when server is not in the map', () => {
    mockColorMap.mockReturnValue(new Map());
    render(<ServerColumnCell server={{ id: 'unknown', name: 'Other' }} />);
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});
