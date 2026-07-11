import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { UserRow } from './UserRow';

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: vi.fn(),
}));

import { useServerColorMap } from '@/hooks/useServerColorMap';

const mockColorMap = vi.mocked(useServerColorMap);

const mergedIdentityServers = [
  { id: 'srv-plex', name: 'Plex' },
  { id: 'srv-jellyfin', name: 'Jellyfin' },
];

function renderRow() {
  return render(
    <MemoryRouter>
      <UserRow
        userId="user-1"
        username="bob"
        identityName="Bob"
        trustScore={90}
        playCount={12}
        watchTimeHours={4}
        identityServers={mergedIdentityServers}
        rank={4}
      />
    </MemoryRouter>
  );
}

describe('UserRow', () => {
  // Regression: same guarantee as UserCard - the runners-up list must show
  // server membership pills for a merged identity no matter how many servers
  // are currently selected in the navbar.
  it('shows server pills for a merged identity when a single server is selected', () => {
    mockColorMap.mockReturnValue(new Map([['srv-plex', '#E5A00D']]));
    renderRow();

    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });

  it('shows server pills for a merged identity when multiple servers are selected', () => {
    mockColorMap.mockReturnValue(
      new Map([
        ['srv-plex', '#E5A00D'],
        ['srv-jellyfin', '#AA5CC3'],
      ])
    );
    renderRow();

    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });
});
