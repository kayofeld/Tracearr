/**
 * QA supplemental tests for the LibraryNeverWatched page.
 *
 * Covers gaps left by NeverWatched.test.tsx:
 * - default item-list query args (category, page, pageSize, default sort added_at asc)
 * - server-side pagination: Next advances the page passed to useLibraryStale
 * - changing the media type filter resets to page 1
 * - clicking a sortable column header propagates sortBy/sortOrder and resets the page
 */

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

function serverReturn() {
  return {
    selectedServerIds: ['srv-1'],
    selectedServers: [{ id: 'srv-1', name: 'Server A' }],
    isMultiServer: false,
    selectedServerId: 'srv-1',
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

function statsReturn() {
  return {
    data: {
      totals: { count: 45, sizeBytes: 45_000_000_000, libraryCount: 100, pctOfLibrary: 45 },
      byMediaType: [
        { mediaType: 'movie', count: 40, sizeBytes: 40_000_000_000 },
        { mediaType: 'show', count: 5, sizeBytes: 5_000_000_000 },
      ],
      byLibrary: [],
      ageDistribution: [
        { bucket: 'lt30', count: 0, sizeBytes: 0 },
        { bucket: 'd30to90', count: 0, sizeBytes: 0 },
        { bucket: 'd90to180', count: 0, sizeBytes: 0 },
        { bucket: 'd180to365', count: 0, sizeBytes: 0 },
        { bucket: 'gt365', count: 45, sizeBytes: 45_000_000_000 },
      ],
      oldestAddedAt: '2020-01-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useLibraryNeverWatched>;
}

/** 45 total items -> 3 pages at pageSize 20, so Next is enabled. */
function itemsReturn() {
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
        },
      ],
      summary: {
        neverWatched: { count: 45, sizeBytes: 45_000_000_000 },
        stale: { count: 0, sizeBytes: 0 },
        total: { count: 45, sizeBytes: 45_000_000_000 },
        threshold: { days: 90 },
      },
      pagination: { page: 1, pageSize: 20, total: 45 },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useLibraryStale>;
}

/** Last useLibraryStale call's positional args. */
function lastItemsArgs() {
  const calls = mockUseLibraryStale.mock.calls;
  return calls[calls.length - 1] as unknown[];
}

describe('LibraryNeverWatched (QA supplemental)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue(serverReturn());
    mockUseLibraryStatus.mockReturnValue(statusReturn());
    mockUseLibraryNeverWatched.mockReturnValue(statsReturn());
    mockUseLibraryStale.mockReturnValue(itemsReturn());
    mockUseRequesterStats.mockReturnValue({
      data: { configuredSources: { ombi: true, seerr: false } },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useRequesterStats>);
  });

  it('queries the never_watched category with default sort added_at asc, page 1, pageSize 20', () => {
    renderPage();

    // useLibraryStale(serverIds, libraryId, staleDays, category, page, pageSize, mediaType, sortBy, sortOrder, mediaTypes)
    const args = lastItemsArgs();
    expect(args[0]).toEqual(['srv-1']);
    expect(args[3]).toBe('never_watched');
    expect(args[4]).toBe(1);
    expect(args[5]).toBe(20);
    expect(args[6]).toBeUndefined(); // mediaType 'all' -> undefined param
    expect(args[7]).toBe('added_at');
    expect(args[8]).toBe('asc');
    // CR-1: the "All" tab scopes the table to movies+shows only, matching the
    // stats endpoint's scope (which never includes 'artist'/music).
    expect(args[9]).toEqual(['movie', 'show']);
  });

  it('advances the server-side page when Next is clicked', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));

    expect(lastItemsArgs()[4]).toBe(2);
  });

  it('resets to page 1 when the media type filter changes', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(lastItemsArgs()[4]).toBe(2);

    await userEvent.click(screen.getByText('library.neverWatched.filterMovies'));

    const args = lastItemsArgs();
    expect(args[4]).toBe(1);
    expect(args[6]).toBe('movie');
    expect(args[9]).toEqual(['movie']);
  });

  it('propagates a column sort to sortBy/sortOrder and resets the page', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(lastItemsArgs()[4]).toBe(2);

    // Click the Title header -> server-side sort by title asc, back to page 1
    await userEvent.click(screen.getByText('library.neverWatched.colTitle'));

    const args = lastItemsArgs();
    expect(args[7]).toBe('title');
    expect(args[8]).toBe('asc');
    expect(args[4]).toBe(1);
  });

  it('toggles the default added_at sort to desc when its header is clicked', async () => {
    renderPage();

    await userEvent.click(screen.getByText('library.neverWatched.colAdded'));

    const args = lastItemsArgs();
    expect(args[7]).toBe('added_at');
    expect(args[8]).toBe('desc');
  });
});
