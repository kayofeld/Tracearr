import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { LibraryNeverWatched } from './NeverWatched';

function renderPage() {
  return render(
    <MemoryRouter>
      <LibraryNeverWatched />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useLibraryNeverWatched: vi.fn(),
  useLibraryStale: vi.fn(),
  useLibraryStatus: vi.fn(),
  useRequesterStats: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

vi.mock('@/components/charts', () => ({
  NeverWatchedAgeChart: () => null,
}));

// The @/components/library barrel also re-exports chart-bearing sections
// (e.g. ResolutionDistributionSection) that import highcharts directly, which
// jsdom can't fully evaluate. Stub the underlying chart libs at the module
// level so importing the barrel for ErrorState/LibraryEmptyState/EmptyState
// doesn't pull in real highcharts code.
vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts-react-official', () => ({ HighchartsReact: () => null }));

import {
  useLibraryNeverWatched,
  useLibraryStale,
  useLibraryStatus,
  useRequesterStats,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseLibraryNeverWatched = vi.mocked(useLibraryNeverWatched);
const mockUseLibraryStale = vi.mocked(useLibraryStale);
const mockUseLibraryStatus = vi.mocked(useLibraryStatus);
const mockUseRequesterStats = vi.mocked(useRequesterStats);
const mockUseServer = vi.mocked(useServer);

function requesterStatsReturn(
  configuredSources: { ombi: boolean; seerr: boolean } | undefined = {
    ombi: true,
    seerr: false,
  }
) {
  return {
    data: {
      requesters: [],
      unattributed: {
        userId: null,
        username: null,
        requestCount: 0,
        movieCount: 0,
        tvCount: 0,
        statusCounts: { pending: 0, approved: 0, denied: 0, available: 0 },
        matchedToLibraryCount: 0,
        totalSizeBytes: 0,
        neverWatchedCount: 0,
        neverWatchedSizeBytes: 0,
        watchedByRequesterCount: 0,
        firstRequestAt: null,
        lastRequestAt: null,
      },
      totals: {
        requestCount: 0,
        requesterCount: 0,
        unattributedCount: 0,
        neverWatchedSizeBytes: 0,
      },
      configured: true,
      configuredSources,
      generatedAt: '2023-06-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useRequesterStats>;
}

function serverReturn(overrides: Partial<ReturnType<typeof useServer>> = {}) {
  return {
    selectedServerIds: ['srv-1'],
    selectedServers: [{ id: 'srv-1', name: 'Server A' }],
    isMultiServer: false,
    selectedServerId: 'srv-1',
    ...overrides,
  } as unknown as ReturnType<typeof useServer>;
}

function statusReturn() {
  return {
    byServer: new Map([
      ['srv-1', { data: { isSynced: true, needsBackfill: false, isBackfillRunning: false } }],
    ]),
    isLoading: false,
    isFetching: false,
    error: null,
  } as unknown as ReturnType<typeof useLibraryStatus>;
}

function neverWatchedStatsReturn(
  overrides: Partial<ReturnType<typeof useLibraryNeverWatched>> = {}
) {
  return {
    data: {
      totals: { count: 2, sizeBytes: 20_000_000_000, libraryCount: 50, pctOfLibrary: 4 },
      byMediaType: [
        { mediaType: 'movie', count: 1, sizeBytes: 10_000_000_000 },
        { mediaType: 'show', count: 1, sizeBytes: 10_000_000_000 },
      ],
      byLibrary: [
        {
          serverId: 'srv-1',
          serverName: 'Server A',
          libraryId: 'lib-1',
          libraryName: 'Movies',
          count: 2,
          sizeBytes: 20_000_000_000,
        },
      ],
      ageDistribution: [
        { bucket: 'lt30', count: 0, sizeBytes: 0 },
        { bucket: 'd30to90', count: 0, sizeBytes: 0 },
        { bucket: 'd90to180', count: 0, sizeBytes: 0 },
        { bucket: 'd180to365', count: 1, sizeBytes: 10_000_000_000 },
        { bucket: 'gt365', count: 1, sizeBytes: 10_000_000_000 },
      ],
      oldestAddedAt: '2023-01-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryNeverWatched>;
}

function staleItemsReturn(overrides: Partial<ReturnType<typeof useLibraryStale>> = {}) {
  return {
    data: {
      items: [
        {
          id: 'item-1',
          serverId: 'srv-1',
          serverName: 'Server A',
          libraryId: 'lib-1',
          libraryName: 'Movies',
          title: 'Old Forgotten Movie',
          mediaType: 'movie',
          year: 2010,
          fileSize: 12_000_000_000,
          resolution: '1080p',
          addedAt: '2023-01-01T00:00:00Z',
          lastWatched: null,
          watchCount: 0,
          category: 'never_watched',
          daysStale: 900,
          requestedBy: null,
        },
      ],
      summary: {
        neverWatched: { count: 2, sizeBytes: 20_000_000_000 },
        stale: { count: 0, sizeBytes: 0 },
        total: { count: 2, sizeBytes: 20_000_000_000 },
        threshold: { days: 90 },
      },
      pagination: { page: 1, pageSize: 20, total: 2 },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryStale>;
}

describe('LibraryNeverWatched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue(serverReturn());
    mockUseLibraryStatus.mockReturnValue(statusReturn());
    mockUseLibraryNeverWatched.mockReturnValue(neverWatchedStatsReturn());
    mockUseLibraryStale.mockReturnValue(staleItemsReturn());
    mockUseRequesterStats.mockReturnValue(requesterStatsReturn());
  });

  it('renders stats and table rows from the mocked hooks', () => {
    renderPage();

    // Stat card value for the never-watched count
    expect(screen.getByText('2')).toBeInTheDocument();
    // Table row for the mocked item
    expect(screen.getByText('Old Forgotten Movie')).toBeInTheDocument();
    expect(screen.getByText('(2010)')).toBeInTheDocument();
  });

  it('renders the real library display name in the "By Library" breakdown, unprefixed on a single server', () => {
    renderPage();

    expect(screen.getByText('Movies')).toBeInTheDocument();
    expect(screen.queryByText(/Server A · Movies/)).not.toBeInTheDocument();
  });

  it('prefixes the library name with the server name in the "By Library" breakdown on multiple servers', () => {
    mockUseServer.mockReturnValue(serverReturn({ isMultiServer: true }));

    renderPage();

    expect(screen.getByText('Server A · Movies')).toBeInTheDocument();
  });

  it('falls back to a placeholder in the "By Library" breakdown when libraryName is empty', () => {
    mockUseLibraryNeverWatched.mockReturnValue(
      neverWatchedStatsReturn({
        data: {
          totals: { count: 2, sizeBytes: 20_000_000_000, libraryCount: 50, pctOfLibrary: 4 },
          byMediaType: [
            { mediaType: 'movie', count: 1, sizeBytes: 10_000_000_000 },
            { mediaType: 'show', count: 1, sizeBytes: 10_000_000_000 },
          ],
          byLibrary: [
            {
              serverId: 'srv-1',
              serverName: 'Server A',
              libraryId: 'lib-1',
              libraryName: '',
              count: 2,
              sizeBytes: 20_000_000_000,
            },
          ],
          ageDistribution: [
            { bucket: 'lt30', count: 0, sizeBytes: 0 },
            { bucket: 'd30to90', count: 0, sizeBytes: 0 },
            { bucket: 'd90to180', count: 0, sizeBytes: 0 },
            { bucket: 'd180to365', count: 1, sizeBytes: 10_000_000_000 },
            { bucket: 'gt365', count: 1, sizeBytes: 10_000_000_000 },
          ],
          oldestAddedAt: '2023-01-01T00:00:00Z',
        },
      })
    );

    renderPage();

    expect(screen.getByText('common:labels.unknown')).toBeInTheDocument();
  });

  it('shows the empty state once stats have loaded and there are no never-watched items', () => {
    mockUseLibraryNeverWatched.mockReturnValue(
      neverWatchedStatsReturn({
        data: {
          totals: { count: 0, sizeBytes: 0, libraryCount: 50, pctOfLibrary: 0 },
          byMediaType: [],
          byLibrary: [],
          ageDistribution: [
            { bucket: 'lt30', count: 0, sizeBytes: 0 },
            { bucket: 'd30to90', count: 0, sizeBytes: 0 },
            { bucket: 'd90to180', count: 0, sizeBytes: 0 },
            { bucket: 'd180to365', count: 0, sizeBytes: 0 },
            { bucket: 'gt365', count: 0, sizeBytes: 0 },
          ],
          oldestAddedAt: null,
        },
      })
    );
    mockUseLibraryStale.mockReturnValue(
      staleItemsReturn({
        data: {
          items: [],
          summary: {
            neverWatched: { count: 0, sizeBytes: 0 },
            stale: { count: 0, sizeBytes: 0 },
            total: { count: 0, sizeBytes: 0 },
            threshold: { days: 90 },
          },
          pagination: { page: 1, pageSize: 20, total: 0 },
        },
      })
    );

    renderPage();

    expect(screen.getByText('library.neverWatched.emptyTitle')).toBeInTheDocument();
    expect(screen.queryByText('Old Forgotten Movie')).not.toBeInTheDocument();
  });

  it('shows a page-level error state when a query fails, and retry refetches both queries', async () => {
    const refetchStats = vi.fn();
    const refetchItems = vi.fn();
    mockUseLibraryNeverWatched.mockReturnValue(
      neverWatchedStatsReturn({
        data: undefined,
        isError: true,
        error: new Error('never-watched failed'),
        refetch: refetchStats,
      })
    );
    mockUseLibraryStale.mockReturnValue(staleItemsReturn({ refetch: refetchItems }));

    renderPage();

    expect(screen.getByText('never-watched failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetchStats).toHaveBeenCalled();
    expect(refetchItems).toHaveBeenCalled();
  });

  it('keeps the tabs mounted when a filtered tab has zero items (CR-2 regression)', async () => {
    // The "All" tab has items, so the page renders normally on first mount.
    // Once the "Movies" tab is selected, the stats/items hooks report a
    // filtered zero - the global "everything watched" empty state must not
    // take over and unmount the tab switcher.
    mockUseLibraryNeverWatched.mockImplementation((_ids, _libraryId, mediaType) => {
      if (mediaType === 'movie') {
        return neverWatchedStatsReturn({
          data: {
            totals: { count: 0, sizeBytes: 0, libraryCount: 50, pctOfLibrary: 0 },
            byMediaType: [],
            byLibrary: [],
            ageDistribution: [
              { bucket: 'lt30', count: 0, sizeBytes: 0 },
              { bucket: 'd30to90', count: 0, sizeBytes: 0 },
              { bucket: 'd90to180', count: 0, sizeBytes: 0 },
              { bucket: 'd180to365', count: 0, sizeBytes: 0 },
              { bucket: 'gt365', count: 0, sizeBytes: 0 },
            ],
            oldestAddedAt: null,
          },
        });
      }
      return neverWatchedStatsReturn();
    });
    mockUseLibraryStale.mockImplementation(
      (_ids, _libraryId, _staleDays, _category, _page, _pageSize, mediaType) => {
        if (mediaType === 'movie') {
          return staleItemsReturn({
            data: {
              items: [],
              summary: {
                neverWatched: { count: 0, sizeBytes: 0 },
                stale: { count: 0, sizeBytes: 0 },
                total: { count: 0, sizeBytes: 0 },
                threshold: { days: 90 },
              },
              pagination: { page: 1, pageSize: 20, total: 0 },
            },
          });
        }
        return staleItemsReturn();
      }
    );

    renderPage();

    await userEvent.click(screen.getByText('library.neverWatched.filterMovies'));

    // The tab switcher (and every tab) is still in the document - the page
    // did not fall back to the global empty state.
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByText('library.neverWatched.filterAll')).toBeInTheDocument();
    expect(screen.getByText('library.neverWatched.filterSeries')).toBeInTheDocument();
    expect(screen.queryByText('Old Forgotten Movie')).not.toBeInTheDocument();
  });

  it('passes the selected media type filter through to both hooks', async () => {
    renderPage();

    await userEvent.click(screen.getByText('library.neverWatched.filterMovies'));

    const statsCalls = mockUseLibraryNeverWatched.mock.calls;
    const lastStatsCall = statsCalls[statsCalls.length - 1];
    expect(lastStatsCall?.[2]).toBe('movie');

    const itemsCalls = mockUseLibraryStale.mock.calls;
    const lastItemsCall = itemsCalls[itemsCalls.length - 1];
    // useLibraryStale(serverIds, libraryId, staleDays, category, page, pageSize, mediaType, sortBy, sortOrder)
    expect(lastItemsCall?.[6]).toBe('movie');
  });

  describe('requestedBy attribution column', () => {
    it('renders a muted dash when requestedBy is null (connector off or unmatched)', () => {
      renderPage();

      expect(screen.getByText('library.neverWatched.requestedByNone')).toBeInTheDocument();
    });

    it('renders the resolved Tracearr username and the other-requester badge when present', () => {
      mockUseLibraryStale.mockReturnValue(
        staleItemsReturn({
          data: {
            items: [
              {
                id: 'item-1',
                serverId: 'srv-1',
                serverName: 'Server A',
                libraryId: 'lib-1',
                libraryName: 'Movies',
                title: 'Old Forgotten Movie',
                mediaType: 'movie',
                year: 2010,
                fileSize: 12_000_000_000,
                resolution: '1080p',
                addedAt: '2023-01-01T00:00:00Z',
                lastWatched: null,
                watchCount: 0,
                category: 'never_watched',
                daysStale: 900,
                requestedBy: {
                  userId: 'user-1',
                  username: 'alice',
                  ombiUsername: 'alice.ombi',
                  ombiAlias: null,
                  requestedAt: '2023-01-01T00:00:00Z',
                  otherRequesterCount: 2,
                  source: 'ombi',
                },
              },
            ],
            summary: {
              neverWatched: { count: 1, sizeBytes: 12_000_000_000 },
              stale: { count: 0, sizeBytes: 0 },
              total: { count: 1, sizeBytes: 12_000_000_000 },
              threshold: { days: 90 },
            },
            pagination: { page: 1, pageSize: 20, total: 1 },
          },
        })
      );

      renderPage();

      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('library.neverWatched.requestedByOthers')).toBeInTheDocument();
    });

    it('falls back to the raw Ombi identity when unattributed to a Tracearr user', () => {
      mockUseLibraryStale.mockReturnValue(
        staleItemsReturn({
          data: {
            items: [
              {
                id: 'item-1',
                serverId: 'srv-1',
                serverName: 'Server A',
                libraryId: 'lib-1',
                libraryName: 'Movies',
                title: 'Old Forgotten Movie',
                mediaType: 'movie',
                year: 2010,
                fileSize: 12_000_000_000,
                resolution: '1080p',
                addedAt: '2023-01-01T00:00:00Z',
                lastWatched: null,
                watchCount: 0,
                category: 'never_watched',
                daysStale: 900,
                requestedBy: {
                  userId: null,
                  username: null,
                  ombiUsername: 'raw-requester',
                  ombiAlias: 'Friendly Name',
                  requestedAt: '2023-01-01T00:00:00Z',
                  otherRequesterCount: 0,
                  source: 'ombi',
                },
              },
            ],
            summary: {
              neverWatched: { count: 1, sizeBytes: 12_000_000_000 },
              stale: { count: 0, sizeBytes: 0 },
              total: { count: 1, sizeBytes: 12_000_000_000 },
              threshold: { days: 90 },
            },
            pagination: { page: 1, pageSize: 20, total: 1 },
          },
        })
      );

      renderPage();

      expect(screen.getByText('Friendly Name')).toBeInTheDocument();
      expect(screen.queryByText('library.neverWatched.requestedByOthers')).not.toBeInTheDocument();
    });

    function itemWithRequestedBy(source: 'ombi' | 'seerr') {
      return staleItemsReturn({
        data: {
          items: [
            {
              id: 'item-1',
              serverId: 'srv-1',
              serverName: 'Server A',
              libraryId: 'lib-1',
              libraryName: 'Movies',
              title: 'Old Forgotten Movie',
              mediaType: 'movie',
              year: 2010,
              fileSize: 12_000_000_000,
              resolution: '1080p',
              addedAt: '2023-01-01T00:00:00Z',
              lastWatched: null,
              watchCount: 0,
              category: 'never_watched',
              daysStale: 900,
              requestedBy: {
                userId: 'user-1',
                username: 'alice',
                ombiUsername: 'alice.source',
                ombiAlias: null,
                requestedAt: '2023-01-01T00:00:00Z',
                otherRequesterCount: 0,
                source,
              },
            },
          ],
          summary: {
            neverWatched: { count: 1, sizeBytes: 12_000_000_000 },
            stale: { count: 0, sizeBytes: 0 },
            total: { count: 1, sizeBytes: 12_000_000_000 },
            threshold: { days: 90 },
          },
          pagination: { page: 1, pageSize: 20, total: 1 },
        },
      });
    }

    it('does not show a connector source badge when only one connector is configured', () => {
      mockUseRequesterStats.mockReturnValue(requesterStatsReturn({ ombi: true, seerr: false }));
      mockUseLibraryStale.mockReturnValue(itemWithRequestedBy('ombi'));

      renderPage();

      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.queryByText('library.neverWatched.sourceOmbi')).not.toBeInTheDocument();
      expect(screen.queryByText('library.neverWatched.sourceSeerr')).not.toBeInTheDocument();
    });

    it('shows the Seerr connector source badge once both connectors are configured', () => {
      mockUseRequesterStats.mockReturnValue(requesterStatsReturn({ ombi: true, seerr: true }));
      mockUseLibraryStale.mockReturnValue(itemWithRequestedBy('seerr'));

      renderPage();

      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('library.neverWatched.sourceSeerr')).toBeInTheDocument();
    });

    it('shows the Ombi connector source badge once both connectors are configured', () => {
      mockUseRequesterStats.mockReturnValue(requesterStatsReturn({ ombi: true, seerr: true }));
      mockUseLibraryStale.mockReturnValue(itemWithRequestedBy('ombi'));

      renderPage();

      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('library.neverWatched.sourceOmbi')).toBeInTheDocument();
    });

    it('does not show a source badge when configuredSources is absent (older server)', () => {
      mockUseRequesterStats.mockReturnValue(requesterStatsReturn(undefined));
      mockUseLibraryStale.mockReturnValue(itemWithRequestedBy('seerr'));

      renderPage();

      expect(screen.queryByText('library.neverWatched.sourceSeerr')).not.toBeInTheDocument();
    });
  });
});
