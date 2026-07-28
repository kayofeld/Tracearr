import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserRequestsCard } from './UserRequestsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'pages:userDetail.requestsCard.byCountDetail') {
        return `${opts?.neverWatched} of ${opts?.matched} in your library`;
      }
      if (key === 'pages:userDetail.requestsCard.bySizeDetail') {
        return `${opts?.wasted} of ${opts?.total} in your library`;
      }
      return key;
    },
  }),
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

function requesterRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'user-1',
    username: 'alice',
    requestCount: 40,
    movieCount: 30,
    tvCount: 10,
    statusCounts: { pending: 0, approved: 2, denied: 0, available: 38 },
    matchedToLibraryCount: 38,
    totalSizeBytes: 500_000_000_000,
    neverWatchedCount: 12,
    neverWatchedSizeBytes: 88 * 1024 * 1024 * 1024, // 88 GiB
    watchedByRequesterCount: 26,
    firstRequestAt: '2023-01-01T00:00:00Z',
    lastRequestAt: '2023-06-01T00:00:00Z',
    ...overrides,
  };
}

function statsReturn(overrides: Partial<ReturnType<typeof useRequesterStats>> = {}) {
  return {
    data: {
      requesters: [requesterRow()],
      unattributed: requesterRow({ userId: null, username: null }),
      totals: {
        requestCount: 40,
        requesterCount: 1,
        unattributedCount: 0,
        neverWatchedSizeBytes: 88 * 1024 * 1024 * 1024,
      },
      configured: true,
      generatedAt: '2023-06-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useRequesterStats>;
}

describe('UserRequestsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: ['srv-1'],
    } as unknown as ReturnType<typeof useServer>);
  });

  it("renders the proportion of the matching user's requests that went unwatched, by count and by size", () => {
    mockUseRequesterStats.mockReturnValue(statsReturn());

    render(<UserRequestsCard userId="user-1" />);

    // Ratio by count: 12 of 38 matched requests = 32%, denominator is what
    // matched the library, not the raw request count (40).
    expect(screen.getByText('32%')).toBeInTheDocument();
    expect(screen.getByText('12 of 38 in your library')).toBeInTheDocument();

    // Ratio by size: 88 GiB of ~465.66 GiB matched storage = 19%.
    expect(screen.getByText('19%')).toBeInTheDocument();
    expect(screen.getByText('88 GB of 465.7 GB in your library')).toBeInTheDocument();

    // Movie/series split and watched-by-this-user count for context.
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('26')).toBeInTheDocument();
  });

  it('does not render NaN or Infinity when nothing has matched the library yet', () => {
    mockUseRequesterStats.mockReturnValue(
      statsReturn({
        data: {
          requesters: [
            requesterRow({
              matchedToLibraryCount: 0,
              totalSizeBytes: 0,
              neverWatchedCount: 0,
              neverWatchedSizeBytes: 0,
            }),
          ],
          unattributed: requesterRow({ userId: null, username: null }),
          totals: {
            requestCount: 40,
            requesterCount: 1,
            unattributedCount: 0,
            neverWatchedSizeBytes: 0,
          },
          configured: true,
          generatedAt: '2023-06-01T00:00:00Z',
        },
      })
    );

    render(<UserRequestsCard userId="user-1" />);

    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
    expect(screen.getAllByText('-')).toHaveLength(2);
    expect(screen.getAllByText('pages:userDetail.requestsCard.noLibraryMatch')).toHaveLength(2);
  });

  it('renders nothing at all when the Ombi connector is not configured', () => {
    mockUseRequesterStats.mockReturnValue(
      statsReturn({
        data: {
          requesters: [],
          unattributed: requesterRow({
            userId: null,
            username: null,
            requestCount: 0,
            movieCount: 0,
            tvCount: 0,
            neverWatchedCount: 0,
            neverWatchedSizeBytes: 0,
            watchedByRequesterCount: 0,
            firstRequestAt: null,
            lastRequestAt: null,
          }),
          totals: {
            requestCount: 0,
            requesterCount: 0,
            unattributedCount: 0,
            neverWatchedSizeBytes: 0,
          },
          configured: false,
          generatedAt: '2023-06-01T00:00:00Z',
        },
      })
    );

    const { container } = render(<UserRequestsCard userId="user-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a neutral empty state, not zeros, when no requester row matches this profile', () => {
    // Regression: the owner's own account is unattributed today because two
    // identities share a username - this must read as "not linked", never as
    // "requested nothing".
    mockUseRequesterStats.mockReturnValue(statsReturn());

    render(<UserRequestsCard userId="user-does-not-match" />);

    expect(screen.getByText('pages:userDetail.requestsCard.notLinked')).toBeInTheDocument();
    expect(screen.queryByText('32%')).not.toBeInTheDocument();
  });

  it('shows the neutral empty state when userId is null or undefined', () => {
    mockUseRequesterStats.mockReturnValue(statsReturn());

    render(<UserRequestsCard userId={undefined} />);

    expect(screen.getByText('pages:userDetail.requestsCard.notLinked')).toBeInTheDocument();
  });

  it('shows a loading skeleton while the query is in flight', () => {
    mockUseRequesterStats.mockReturnValue(statsReturn({ data: undefined, isLoading: true }));

    render(<UserRequestsCard userId="user-1" />);

    expect(screen.getByText('pages:userDetail.requestsCard.title')).toBeInTheDocument();
    expect(screen.queryByText('32%')).not.toBeInTheDocument();
  });
});
