import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { BandwidthTopUser } from '@tracearr/shared';
import { StatsBandwidth } from './Bandwidth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Highcharts touches CSS.supports at import time, which jsdom does not implement.
vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts-react-official', () => ({ HighchartsReact: () => null }));

vi.mock('@/hooks/queries', () => ({
  useBandwidthDaily: vi.fn(),
  useBandwidthTopUsers: vi.fn(),
  useBandwidthSummary: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

import { useBandwidthDaily, useBandwidthTopUsers, useBandwidthSummary } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseBandwidthDaily = vi.mocked(useBandwidthDaily);
const mockUseBandwidthTopUsers = vi.mocked(useBandwidthTopUsers);
const mockUseBandwidthSummary = vi.mocked(useBandwidthSummary);
const mockUseServer = vi.mocked(useServer);

function topUser(overrides: Partial<BandwidthTopUser> & { username: string }): BandwidthTopUser {
  return {
    identityName: null,
    thumbUrl: null,
    serverUserId: `su-${overrides.username}`,
    serverId: 'server-1',
    totalBytes: 0,
    totalGb: 0,
    sessions: 0,
    avgBitrate: 0,
    totalDurationMs: 0,
    avgBitrateMbps: 0,
    totalHours: 0,
    ...overrides,
  };
}

const rows = [
  topUser({ username: 'alice', totalBytes: 3_000_000_000 }),
  topUser({ username: 'bob', totalBytes: 2_000_000_000 }),
  topUser({ username: 'carol', totalBytes: 1_000_000_000, serverId: 'server-2' }),
];

function mockTopUsers(data: BandwidthTopUser[] | undefined, isLoading = false) {
  mockUseBandwidthTopUsers.mockReturnValue({
    data: data ? { data } : undefined,
    isLoading,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useBandwidthTopUsers>);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/stats/bandwidth']}>
      <StatsBandwidth />
    </MemoryRouter>
  );
}

function bodyRows() {
  const body = screen.getAllByRole('rowgroup')[1]!;
  return within(body).getAllByRole('row');
}

function cellTexts(rowIndex: number) {
  return within(bodyRows()[rowIndex]!)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

describe('StatsBandwidth top users table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: ['server-1'],
      selectedServers: [{ id: 'server-1', name: 'Server One', color: '#ff0000' }],
      isMultiServer: false,
    } as unknown as ReturnType<typeof useServer>);
    mockUseBandwidthDaily.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBandwidthDaily>);
    mockUseBandwidthSummary.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBandwidthSummary>);
    mockTopUsers(rows);
  });

  it('keeps the API order and omits the server column on a single server', () => {
    renderPage();

    expect(bodyRows()).toHaveLength(3);
    expect(cellTexts(0)).toEqual(['1', 'ALalice', '0', '2.8 GB', '0.0h', '0.0 Mbps']);
    expect(cellTexts(2)[1]).toBe('CAcarol');
    expect(screen.queryByText('common:labels.server')).not.toBeInTheDocument();
  });

  it('adds the server column and the per-row colour accent on multiple servers', () => {
    mockUseServer.mockReturnValue({
      selectedServerIds: ['server-1', 'server-2'],
      selectedServers: [
        { id: 'server-1', name: 'Server One', color: '#ff0000' },
        { id: 'server-2', name: 'Server Two', color: '#00ff00' },
      ],
      isMultiServer: true,
    } as unknown as ReturnType<typeof useServer>);

    renderPage();

    expect(screen.getByText('common:labels.server')).toBeInTheDocument();
    expect(cellTexts(0)).toEqual(['1', 'ALalice', 'Server One', '0', '2.8 GB', '0.0h', '0.0 Mbps']);
    expect(bodyRows()[0]!).toHaveStyle({ boxShadow: 'inset 3px 0 0 0 #ff0000' });
    expect(bodyRows()[2]!).toHaveStyle({ boxShadow: 'inset 3px 0 0 0 #00ff00' });
  });

  it('sorts ascending on the first data-header click and pins rank to the API order', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'common:labels.data' }));

    expect(bodyRows().map((row) => within(row).getAllByRole('cell')[1]!.textContent)).toEqual([
      'CAcarol',
      'BObob',
      'ALalice',
    ]);
    expect(cellTexts(0)[0]).toBe('3');
    expect(cellTexts(2)[0]).toBe('1');
    expect(screen.getByRole('columnheader', { name: /common:labels.data/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
  });

  it('renders skeleton rows while loading and the shared empty state when there is no data', () => {
    mockTopUsers(undefined, true);
    const { unmount } = renderPage();
    expect(screen.getAllByRole('rowgroup')[1]!).toHaveAttribute('aria-busy', 'true');
    unmount();

    mockTopUsers([]);
    renderPage();
    expect(screen.getByText('common:empty.noUserData')).toBeInTheDocument();
  });
});
