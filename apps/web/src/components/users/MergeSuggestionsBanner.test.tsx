import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MergeSuggestion } from '@tracearr/shared';
import { MergeSuggestionsBanner } from './MergeSuggestionsBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useMergeSuggestions: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

import { useMergeSuggestions } from '@/hooks/queries';

const mockUseMergeSuggestions = vi.mocked(useMergeSuggestions);

function suggestion(): MergeSuggestion {
  return {
    matchType: 'email',
    matchValue: 'bob@example.com',
    users: [
      {
        userId: 'user-a',
        username: 'bob',
        name: null,
        email: 'bob@example.com',
        role: 'member',
        loginCapable: false,
        serverUsers: [
          {
            id: 'su-a',
            serverId: 's1',
            serverName: 'Plex',
            username: 'bob',
            email: 'bob@example.com',
            removedAt: null,
          },
        ],
      },
      {
        userId: 'user-b',
        username: 'bob',
        name: null,
        email: null,
        role: 'member',
        loginCapable: false,
        serverUsers: [
          {
            id: 'su-b',
            serverId: 's2',
            serverName: 'Jellyfin',
            username: 'bob',
            email: 'bob@example.com',
            removedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
    requiredTargetUserId: null,
    wouldCombineSameServer: false,
  };
}

describe('MergeSuggestionsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when there are no suggestions', () => {
    mockUseMergeSuggestions.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    const { container } = render(<MergeSuggestionsBanner onReview={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while loading', () => {
    mockUseMergeSuggestions.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    const { container } = render(<MergeSuggestionsBanner onReview={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an error message when loading fails', () => {
    mockUseMergeSuggestions.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    render(<MergeSuggestionsBanner onReview={vi.fn()} />);
    expect(screen.getByText('pages:users.suggestionsError')).toBeInTheDocument();
  });

  it('lists suggestions and forwards the reviewed suggestion', async () => {
    const item = suggestion();
    mockUseMergeSuggestions.mockReturnValue({
      data: [item],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    const onReview = vi.fn();
    render(<MergeSuggestionsBanner onReview={onReview} />);

    expect(screen.getByText('pages:users.suggestionsTitle')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'pages:users.suggestionsReview' }));
    expect(onReview).toHaveBeenCalledWith(item);
  });

  it('labels a removed server account as historical, matching the dialog badge convention', () => {
    const item = suggestion();
    mockUseMergeSuggestions.mockReturnValue({
      data: [item],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    render(<MergeSuggestionsBanner onReview={vi.fn()} />);

    expect(screen.getByText('pages:users.mergeServerAccountRemoved')).toBeInTheDocument();
  });

  it('renders suggestions with list semantics inside a labelled region', () => {
    const item = suggestion();
    mockUseMergeSuggestions.mockReturnValue({
      data: [item],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    render(<MergeSuggestionsBanner onReview={vi.fn()} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});
