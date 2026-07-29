import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Settings } from '@tracearr/shared';
import type * as ApiModule from '@/lib/api';
import type * as SettingsHooks from '@/hooks/queries/useSettings';
import type { TelegramPairingStatus } from './telegramPairingContract';
import { EditAgentDialog } from './EditAgentDialog';

// Telegram never re-populates its bot token into an editable field (it's a
// secret we never render back - see the brief). Editing shows a "connected"
// summary instead, with a "Re-pair bot" action that re-opens the same wizard
// used when first adding the agent.

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

vi.mock('@/hooks/queries/useSettings', async () => {
  const actual = await vi.importActual<typeof SettingsHooks>('@/hooks/queries/useSettings');
  return { ...actual, useUpdateSettings: vi.fn() };
});

import { useUpdateSettings } from '@/hooks/queries/useSettings';
const mockUseUpdateSettings = vi.mocked(useUpdateSettings);

function renderDialog(settings: Partial<Settings>, onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EditAgentDialog
        open
        onOpenChange={onOpenChange}
        agentType="telegram"
        settings={settings as Settings}
      />
    </QueryClientProvider>
  );
  return { onOpenChange };
}

describe('EditAgentDialog - Telegram', () => {
  let mutateAsync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCancel.mockResolvedValue(undefined);
    mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseUpdateSettings.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateSettings>);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a connected summary (never the raw bot token) with the current chat id', () => {
    renderDialog({ telegramBotToken: 'super-secret-token', telegramChatId: 'chat-1' });

    expect(screen.getByText(/editConnectedTitle/)).toBeInTheDocument();
    expect(screen.getByText(/editConnectedDesc/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('super-secret-token')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/botTokenLabel/)).not.toBeInTheDocument();
  });

  it('re-pairing opens the wizard and saves the new bot token + chat id, then closes', async () => {
    mockStart.mockResolvedValue({
      pairingId: 'p2',
      code: 'NEWCODE',
      botUsername: '@tracearr_bot',
      botLink: 'https://t.me/tracearr_bot',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    mockStatus.mockResolvedValue({
      state: 'paired',
      chatId: 'chat-2',
    } satisfies TelegramPairingStatus);

    const { onOpenChange } = renderDialog({
      telegramBotToken: 'old-token',
      telegramChatId: 'chat-1',
    });

    fireEvent.click(screen.getByRole('button', { name: /editRepairButton/ }));
    expect(screen.getByLabelText(/botTokenLabel/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/botTokenLabel/), {
      target: { value: '222:newtoken' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continueButton/ }));
    });

    await screen.findByDisplayValue('NEWCODE');

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        telegramBotToken: '222:newtoken',
        telegramChatId: 'chat-2',
        webhookFormat: 'telegram',
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
