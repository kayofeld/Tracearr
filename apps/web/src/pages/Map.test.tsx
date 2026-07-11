import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Map as MapPage } from './Map';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/map', () => ({
  StreamMap: () => <div data-testid="stream-map" />,
}));

vi.mock('@/hooks/queries', () => ({
  useLocationStats: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

import { useLocationStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseLocationStats = vi.mocked(useLocationStats);
const mockUseServer = vi.mocked(useServer);

function renderMap() {
  return render(
    <MemoryRouter>
      <MapPage />
    </MemoryRouter>
  );
}

describe('Map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      isMultiServer: false,
    } as unknown as ReturnType<typeof useServer>);
  });

  it('shows the map once locations have loaded', () => {
    mockUseLocationStats.mockReturnValue({
      data: { data: [], summary: undefined, availableFilters: undefined },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useLocationStats>);

    renderMap();

    expect(screen.getByTestId('stream-map')).toBeInTheDocument();
  });

  it('shows an error state instead of the map when the locations query fails, and retry refetches it', async () => {
    const refetch = vi.fn();
    mockUseLocationStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('locations failed'),
      refetch,
    } as unknown as ReturnType<typeof useLocationStats>);

    renderMap();

    expect(screen.queryByTestId('stream-map')).not.toBeInTheDocument();
    expect(screen.getByText('common:errors.somethingWentWrong')).toBeInTheDocument();
    expect(screen.getByText('locations failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
