import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserRequestsCard } from './UserRequestsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'pages:userDetail.requestsCard.neverWatchedOf') {
        return `${opts?.neverWatched} of ${opts?.count} requests never watched`;
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

  it("renders the matching user's requests, never-watched count, and wasted storage", () => {
    mockUseRequesterStats.mockReturnValue(statsReturn());

    render(<UserRequestsCard userId="user-1" />);

    // Headline wasted-storage figure.
    expect(screen.getByText('88 GB')).toBeInTheDocument();
    // Context sentence - never a bare accusatory number.
    expect(screen.getByText('12 of 40 requests never watched')).toBeInTheDocument();
    // Movie/series split.
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    // Watched-by-this-user count for context.
    expect(screen.getByText('26')).toBeInTheDocument();
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
    expect(screen.queryByText('88 GB')).not.toBeInTheDocument();
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
    expect(screen.queryByText('88 GB')).not.toBeInTheDocument();
  });
});
