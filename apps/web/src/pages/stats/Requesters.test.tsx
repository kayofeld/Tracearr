import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RequesterStatsResponse } from '@tracearr/shared';
import { StatsRequesters } from './Requesters';

function renderPage() {
  return render(
    <MemoryRouter>
      <StatsRequesters />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useRequesterStats: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

import { useRequesterStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseRequesterStats = vi.mocked(useRequesterStats);
const mockUseServer = vi.mocked(useServer);

/** Base fixture, strongly typed (not wrapped in the query-result shape) so
 * tests can spread it and override just `configuredSources` without TS
 * widening every property to optional (which happens when spreading a
 * possibly-`undefined` `.data` accessor instead). */
function baseRequesterData(): RequesterStatsResponse {
  return {
    requesters: [
      {
        userId: 'user-1',
        username: 'alice',
        requestCount: 10,
        movieCount: 7,
        tvCount: 3,
        statusCounts: { pending: 0, approved: 2, denied: 0, available: 8 },
        matchedToLibraryCount: 9,
        totalSizeBytes: 50_000_000_000,
        neverWatchedCount: 2,
        neverWatchedSizeBytes: 8_000_000_000,
        watchedByRequesterCount: 6,
        firstRequestAt: '2023-01-01T00:00:00Z',
        lastRequestAt: '2023-06-01T00:00:00Z',
      },
    ],
    unattributed: {
      userId: null,
      username: null,
      requestCount: 4,
      movieCount: 3,
      tvCount: 1,
      statusCounts: { pending: 0, approved: 0, denied: 0, available: 4 },
      matchedToLibraryCount: 4,
      totalSizeBytes: 12_000_000_000,
      neverWatchedCount: 1,
      neverWatchedSizeBytes: 3_000_000_000,
      watchedByRequesterCount: 0,
      firstRequestAt: '2023-02-01T00:00:00Z',
      lastRequestAt: '2023-03-01T00:00:00Z',
    },
    totals: {
      requestCount: 14,
      requesterCount: 1,
      unattributedCount: 4,
      neverWatchedSizeBytes: 11_000_000_000,
    },
    configured: true,
    configuredSources: { ombi: true, seerr: false },
    generatedAt: '2023-06-01T00:00:00Z',
  };
}

function requesterStatsReturn(overrides: Partial<ReturnType<typeof useRequesterStats>> = {}) {
  return {
    data: baseRequesterData(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useRequesterStats>;
}

describe('StatsRequesters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: ['srv-1'],
    } as unknown as ReturnType<typeof useServer>);
    mockUseRequesterStats.mockReturnValue(requesterStatsReturn());
  });

  it('renders requester rows and the explicit unattributed bucket', () => {
    renderPage();

    expect(screen.getByText('alice')).toBeInTheDocument();
    // The unattributed bucket is always rendered, never folded silently into totals.
    expect(screen.getByText('statsRequesters.unattributedRow')).toBeInTheDocument();
    // The unattributed card's own requestCount (distinct from the alice row's 10).
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
  });

  it('shows a clear "not configured" empty state (not an error) when neither connector is set up', () => {
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({
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
          configured: false,
          configuredSources: { ombi: false, seerr: false },
          generatedAt: '2023-06-01T00:00:00Z',
        },
      })
    );

    renderPage();

    expect(screen.getByText('statsRequesters.notConfiguredTitle')).toBeInTheDocument();
    // Neither is configured - offer both settings pages, never assume one.
    expect(screen.getByRole('link', { name: /statsRequesters.goToOmbiSettings/ })).toHaveAttribute(
      'href',
      '/settings/ombi'
    );
    expect(screen.getByRole('link', { name: /statsRequesters.goToSeerrSettings/ })).toHaveAttribute(
      'href',
      '/settings/seerr'
    );
    // Not the error state.
    expect(screen.queryByText('statsRequesters.failedToLoad')).not.toBeInTheDocument();
  });

  it('uses Ombi-specific copy when only Ombi is configured', () => {
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({
        data: {
          ...baseRequesterData(),
          configuredSources: { ombi: true, seerr: false },
        },
      })
    );

    renderPage();

    expect(screen.getByText('statsRequesters.descriptionOmbi')).toBeInTheDocument();
    expect(screen.getByText('statsRequesters.unattributedRowDescOmbi')).toBeInTheDocument();
  });

  it('uses Seerr-specific copy when only Seerr is configured', () => {
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({
        data: {
          ...baseRequesterData(),
          configuredSources: { ombi: false, seerr: true },
        },
      })
    );

    renderPage();

    expect(screen.getByText('statsRequesters.descriptionSeerr')).toBeInTheDocument();
    expect(screen.getByText('statsRequesters.unattributedRowDescSeerr')).toBeInTheDocument();
  });

  it('uses source-neutral copy when both connectors are configured', () => {
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({
        data: {
          ...baseRequesterData(),
          configuredSources: { ombi: true, seerr: true },
        },
      })
    );

    renderPage();

    expect(screen.getByText('statsRequesters.descriptionBoth')).toBeInTheDocument();
    expect(screen.getByText('statsRequesters.unattributedRowDescBoth')).toBeInTheDocument();
  });

  it('falls back to source-neutral copy when an older server omits configuredSources', () => {
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({
        data: {
          ...baseRequesterData(),
          configuredSources: undefined,
        },
      })
    );

    renderPage();

    expect(screen.getByText('statsRequesters.descriptionBoth')).toBeInTheDocument();
  });

  it('shows an error state with retry when the query fails', async () => {
    const refetch = vi.fn();
    mockUseRequesterStats.mockReturnValue(
      requesterStatsReturn({ data: undefined, isError: true, error: new Error('boom'), refetch })
    );

    renderPage();

    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
