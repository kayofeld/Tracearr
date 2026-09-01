import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StaleResponse } from '@tracearr/shared';
import { StaleContentTabs } from './StaleContentTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries/useLibrary', () => ({
  useLibraryStale: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

// The @/components/library barrel also re-exports chart-bearing sections
// (CodecDistributionSection -> @/components/charts barrel -> StoragePredictionChart)
// that import highcharts directly, which jsdom can't fully evaluate - stub
// the underlying chart libs at the module level (mirrors NeverWatched.test.tsx,
// plus the `highcharts-more` entry point StoragePredictionChart uses).
vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts/highcharts-more', () => ({ default: {} }));
vi.mock('highcharts-react-official', () => ({ HighchartsReact: () => null }));

import { useLibraryStale } from '@/hooks/queries/useLibrary';

const mockUseLibraryStale = vi.mocked(useLibraryStale);

function staleResponse(overrides: Partial<StaleResponse> = {}): StaleResponse {
  return {
    items: [],
    summary: {
      neverWatched: { count: 0, sizeBytes: 0 },
      stale: { count: 0, sizeBytes: 0 },
      total: { count: 0, sizeBytes: 0 },
      threshold: { days: 90 },
    },
    pagination: { page: 1, pageSize: 20, total: 0 },
    ...overrides,
  };
}

function renderTabs() {
  return render(
    <StaleContentTabs
      serverIds={['srv-1']}
      libraryId={null}
      isMultiServer={false}
      selectedServers={[]}
    />
  );
}

describe('StaleContentTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders no coverage banner when playedStateCoverage is absent', () => {
    mockUseLibraryStale.mockReturnValue({
      data: staleResponse(),
      isLoading: false,
    } as unknown as ReturnType<typeof useLibraryStale>);

    renderTabs();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the coverage banner when playedStateCoverage.full is false', () => {
    mockUseLibraryStale.mockReturnValue({
      data: staleResponse({
        playedStateCoverage: {
          full: false,
          servers: [
            {
              serverId: 'srv-plex',
              serverName: 'Plex Server',
              capability: 'unsupported',
              lastSyncedAt: null,
            },
          ],
        },
      }),
      isLoading: false,
    } as unknown as ReturnType<typeof useLibraryStale>);

    renderTabs();

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('swaps the never-watched tab empty-state copy to "no recorded plays" wording when uncovered', () => {
    mockUseLibraryStale.mockReturnValue({
      data: staleResponse({
        playedStateCoverage: {
          full: false,
          servers: [
            {
              serverId: 'srv-plex',
              serverName: 'Plex Server',
              capability: 'unsupported',
              lastSyncedAt: null,
            },
          ],
        },
      }),
      isLoading: false,
    } as unknown as ReturnType<typeof useLibraryStale>);

    renderTabs();

    expect(screen.getByText('pages:library.neverWatched.emptyTitleNoData')).toBeInTheDocument();
    expect(screen.queryByText('No stale content')).not.toBeInTheDocument();
  });

  it('keeps the default empty-state copy on the never-watched tab when coverage is full', () => {
    mockUseLibraryStale.mockReturnValue({
      data: staleResponse({
        playedStateCoverage: {
          full: true,
          servers: [
            {
              serverId: 'srv-1',
              serverName: 'Emby Server',
              capability: 'supported',
              lastSyncedAt: '2026-07-29T00:00:00Z',
            },
          ],
        },
      }),
      isLoading: false,
    } as unknown as ReturnType<typeof useLibraryStale>);

    renderTabs();

    expect(screen.getByText('No stale content')).toBeInTheDocument();
    expect(
      screen.queryByText('pages:library.neverWatched.emptyTitleNoData')
    ).not.toBeInTheDocument();
  });
});
