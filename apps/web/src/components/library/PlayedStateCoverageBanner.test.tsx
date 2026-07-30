import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlayedStateCoverage } from '@tracearr/shared';
import { PlayedStateCoverageBanner } from './PlayedStateCoverageBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function fullCoverage(): PlayedStateCoverage {
  return {
    full: true,
    servers: [
      {
        serverId: 'srv-1',
        serverName: 'Emby Server',
        capability: 'supported',
        lastSyncedAt: '2026-07-29T00:00:00Z',
      },
    ],
  };
}

function plexUnsupportedCoverage(): PlayedStateCoverage {
  return {
    full: false,
    servers: [
      {
        serverId: 'srv-1',
        serverName: 'Plex Server',
        capability: 'unsupported',
        lastSyncedAt: null,
      },
    ],
  };
}

function pendingSyncCoverage(): PlayedStateCoverage {
  return {
    full: false,
    servers: [
      { serverId: 'srv-2', serverName: 'Emby Server', capability: 'supported', lastSyncedAt: null },
    ],
  };
}

function mixedCoverage(): PlayedStateCoverage {
  return {
    full: false,
    servers: [
      {
        serverId: 'srv-1',
        serverName: 'Plex Server',
        capability: 'unsupported',
        lastSyncedAt: null,
      },
      { serverId: 'srv-2', serverName: 'Emby Server', capability: 'supported', lastSyncedAt: null },
      {
        serverId: 'srv-3',
        serverName: 'Synced Emby',
        capability: 'supported',
        lastSyncedAt: '2026-07-29T00:00:00Z',
      },
    ],
  };
}

describe('PlayedStateCoverageBanner', () => {
  it('renders nothing when coverage is absent (unknown, not "no coverage")', () => {
    const { container } = render(<PlayedStateCoverageBanner coverage={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when coverage is full', () => {
    const { container } = render(<PlayedStateCoverageBanner coverage={fullCoverage()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a banner (role=alert) when full is false', () => {
    render(<PlayedStateCoverageBanner coverage={plexUnsupportedCoverage()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('library.playedStateCoverage.bannerTitle')).toBeInTheDocument();
  });

  it('words a Plex-only (unsupported) gap as a permanent platform limitation, not a pending sync', () => {
    render(<PlayedStateCoverageBanner coverage={plexUnsupportedCoverage()} />);

    // The "unsupported" copy key is used (permanent-limitation wording), and
    // the "pending" copy key (which would imply a sync will eventually fix
    // it) must not appear.
    expect(screen.getByText('library.playedStateCoverage.bannerUnsupported')).toBeInTheDocument();
    expect(screen.queryByText('library.playedStateCoverage.bannerPending')).not.toBeInTheDocument();
    expect(screen.queryByText('library.playedStateCoverage.bannerMixed')).not.toBeInTheDocument();
  });

  it('words a not-yet-synced supported server as a pending sync', () => {
    render(<PlayedStateCoverageBanner coverage={pendingSyncCoverage()} />);

    expect(screen.getByText('library.playedStateCoverage.bannerPending')).toBeInTheDocument();
    expect(
      screen.queryByText('library.playedStateCoverage.bannerUnsupported')
    ).not.toBeInTheDocument();
  });

  it('uses the mixed wording when both an unsupported and a pending server are uncovered', () => {
    render(<PlayedStateCoverageBanner coverage={mixedCoverage()} />);

    expect(screen.getByText('library.playedStateCoverage.bannerMixed')).toBeInTheDocument();
    // The fully-synced server in the mix must not itself trigger different copy.
    expect(
      screen.queryByText('library.playedStateCoverage.bannerUnsupported')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('library.playedStateCoverage.bannerPending')).not.toBeInTheDocument();
  });
});
