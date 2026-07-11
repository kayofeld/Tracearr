import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { UserCard } from './UserCard';

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: vi.fn(),
}));

import { useServerColorMap } from '@/hooks/useServerColorMap';

const mockColorMap = vi.mocked(useServerColorMap);

const mergedIdentityServers = [
  { id: 'srv-plex', name: 'Plex' },
  { id: 'srv-jellyfin', name: 'Jellyfin' },
];

function renderCard() {
  return render(
    <MemoryRouter>
      <UserCard
        userId="user-1"
        username="bob"
        identityName="Bob"
        trustScore={90}
        playCount={12}
        watchTimeHours={4}
        identityServers={mergedIdentityServers}
        rank={1}
      />
    </MemoryRouter>
  );
}

describe('UserCard', () => {
  // Regression: server membership pills must not depend on which servers are
  // selected in the navbar. The leaderboard's identityServers come from the
  // server (scoped by access, not by the caller's current selection), so the
  // color map - the only selection-derived input these pills touch - must
  // never gate whether a merged identity's servers are shown.
  it('shows server pills for a merged identity when a single server is selected', () => {
    mockColorMap.mockReturnValue(new Map([['srv-plex', '#E5A00D']]));
    renderCard();

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
    renderCard();

    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });
});
