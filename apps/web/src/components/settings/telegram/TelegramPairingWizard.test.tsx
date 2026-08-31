import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';
import type { TelegramPairingStart, TelegramPairingStatus } from './telegramPairingContract';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options) return `${key}:${JSON.stringify(options)}`;
      return key;
    },
  }),
}));

const mockStart = vi.fn();
const mockStatus = vi.fn();
const mockCancel = vi.fn();
vi.mock('@/lib/api', async () => {
  // `actual.api` is a class instance - spreading it would drop its prototype,
  // so monkey-patch the methods under test instead of cloning the object
  // (mirrors OmbiSettings.test.tsx / UpdateDialog.test.tsx).
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  actual.api.telegramPairing.start = ((...args: unknown[]) =>
    mockStart(...args)) as typeof actual.api.telegramPairing.start;
  actual.api.telegramPairing.status = ((...args: unknown[]) =>
    mockStatus(...args)) as typeof actual.api.telegramPairing.status;
  actual.api.telegramPairing.cancel = ((...args: unknown[]) =>
    mockCancel(...args)) as typeof actual.api.telegramPairing.cancel;
  return actual;
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TelegramPairingWizard } from './TelegramPairingWizard';

function pairingStart(overrides: Partial<TelegramPairingStart> = {}): TelegramPairingStart {
  return {
    pairingId: 'pairing-1',
    code: 'ABC123',
    botUsername: '@tracearr_bot',
    botLink: 'https://t.me/tracearr_bot',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ...overrides,
  };
}

function renderWizard(onPaired = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const utils = render(<TelegramPairingWizard onPaired={onPaired} />, { wrapper: Wrapper });
  return { ...utils, onPaired };
}

/** Types the bot token and clicks Continue, without userEvent (which hangs
 * combined with fake timers in this suite - fireEvent is timer-agnostic). */
async function submitToken(value = '123456:ABCdef') {
  const input = screen.getByLabelText(/botTokenLabel/);
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continueButton/ }));
  });
}

describe('TelegramPairingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancel.mockResolvedValue(undefined);
    // `shouldAdvanceTime` lets real elapsed time keep the fake clock (and
    // RTL's internal setTimeout-based polling in waitFor/findBy) moving,
    // while `advanceTimersByTimeAsync` below still lets us jump forward
    // deterministically for the poll interval / countdown assertions.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays on step 1 and surfaces the server error when the bot token is invalid', async () => {
    mockStart.mockRejectedValue(new Error('Invalid Telegram bot token'));
    renderWizard();

    await submitToken();

    expect(await screen.findByText('Invalid Telegram bot token')).toBeInTheDocument();
    // Still on step 1 - the token field is still present.
    expect(screen.getByLabelText(/botTokenLabel/)).toBeInTheDocument();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('polls the pairing status and advances once paired, saving with the resolved chat id', async () => {
    const pairing = pairingStart();
    mockStart.mockResolvedValue(pairing);
    mockStatus
      .mockResolvedValueOnce({ state: 'pending', chatId: null } satisfies TelegramPairingStatus)
      .mockResolvedValue({ state: 'paired', chatId: 'chat-42' } satisfies TelegramPairingStatus);

    const onPaired = vi.fn().mockResolvedValue(undefined);
    renderWizard(onPaired);

    await submitToken('123456:ABCdef');

    // Step 2: pairing code + bot link visible, first status poll already fired.
    expect(await screen.findByDisplayValue('ABC123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /openBotButton/ })).toHaveAttribute(
      'href',
      'https://t.me/tracearr_bot'
    );
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    // Advance past the poll interval to pick up the 'paired' status.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await waitFor(() =>
      expect(onPaired).toHaveBeenCalledWith({ botToken: '123456:ABCdef', chatId: 'chat-42' })
    );
    expect((await screen.findAllByText(/step3Title/)).length).toBeGreaterThan(0);
  });

  it('shows the expired state and offers a start-over once the code lapses', async () => {
    const pairing = pairingStart({ expiresAt: new Date(Date.now() + 1000) });
    mockStart.mockResolvedValue(pairing);
    mockStatus.mockResolvedValue({
      state: 'pending',
      chatId: null,
    } satisfies TelegramPairingStatus);

    renderWizard();

    await submitToken();
    expect(await screen.findByDisplayValue('ABC123')).toBeInTheDocument();

    // Local countdown ticks every second; push past the 1s expiry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByText(/expiredTitle/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /startOver/ })).toBeInTheDocument();
  });

  it('stops polling the pairing status once the component unmounts', async () => {
    const pairing = pairingStart();
    mockStart.mockResolvedValue(pairing);
    mockStatus.mockResolvedValue({
      state: 'pending',
      chatId: null,
    } satisfies TelegramPairingStatus);

    const { unmount } = renderWizard();

    await submitToken();
    await screen.findByDisplayValue('ABC123');
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    unmount();
    const callsAtUnmount = mockStatus.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(mockStatus.mock.calls.length).toBe(callsAtUnmount);
  });
});
