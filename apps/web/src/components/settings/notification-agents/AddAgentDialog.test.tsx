import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ApiModule from '@/lib/api';
import type * as SettingsHooks from '@/hooks/queries/useSettings';
import type { TelegramPairingStatus } from './telegramPairingContract';
import { AddAgentDialog } from './AddAgentDialog';
import type { AddableAgentInfo } from './useActiveAgents';

// AddAgentDialog < TelegramPairingWizard integration: verifies the wizard's
// resolved { botToken, chatId } is persisted through the SAME settings-update
// path the generic agent form uses (the "existing agent-creation path" from
// the brief), and that the dialog closes on success - without re-testing the
// wizard's own polling/expiry logic (covered by TelegramPairingWizard.test.tsx).

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

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

vi.mock('@/hooks/queries/useSettings', async () => {
  const actual = await vi.importActual<typeof SettingsHooks>('@/hooks/queries/useSettings');
  return { ...actual, useUpdateSettings: vi.fn() };
});

import { useUpdateSettings } from '@/hooks/queries/useSettings';
const mockUseUpdateSettings = vi.mocked(useUpdateSettings);

function renderDialog(onOpenChange = vi.fn()) {
  const telegramOption: AddableAgentInfo = { type: 'telegram', isAvailable: true };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddAgentDialog
        open
        onOpenChange={onOpenChange}
        discord={null}
        webhookAgents={[telegramOption]}
        activeWebhookAgent={null}
        settings={undefined}
      />
    </QueryClientProvider>
  );
  return { onOpenChange };
}

describe('AddAgentDialog - Telegram wizard integration', () => {
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

  it('selecting Telegram shows the pairing wizard instead of the bot token / chat id fields', async () => {
    renderDialog();

    fireEvent.click(screen.getByText('Telegram'));

    // Wizard's step 1 field, not the old two-field form.
    expect(screen.getByLabelText(/botTokenLabel/)).toBeInTheDocument();
    expect(screen.queryByLabelText('telegramChatId')).not.toBeInTheDocument();
    // No generic "Add Agent" save button while the wizard drives its own steps.
    expect(
      screen.queryByRole('button', { name: 'pages:settings.notifications.saveAgent' })
    ).not.toBeInTheDocument();
  });

  it('saves through the existing settings-update path with the resolved chat id and closes the dialog', async () => {
    mockStart.mockResolvedValue({
      pairingId: 'p1',
      code: 'CODE1',
      botUsername: '@tracearr_bot',
      botLink: 'https://t.me/tracearr_bot',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    mockStatus.mockResolvedValue({
      state: 'paired',
      chatId: 'chat-99',
    } satisfies TelegramPairingStatus);

    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByText('Telegram'));
    fireEvent.change(screen.getByLabelText(/botTokenLabel/), {
      target: { value: '111:tokenvalue' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continueButton/ }));
    });

    await screen.findByDisplayValue('CODE1');

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        telegramBotToken: '111:tokenvalue',
        telegramChatId: 'chat-99',
        webhookFormat: 'telegram',
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastSuccess).toHaveBeenCalled();
  });
});
