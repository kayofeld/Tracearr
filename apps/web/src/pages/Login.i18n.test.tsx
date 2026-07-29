/**
 * Smoke test with the REAL translations package (no react-i18next mock), to catch missing i18n
 * keys and console errors that a mocked-t unit test cannot see - a key that resolves in the mock
 * (which just echoes the key back) but is absent or misspelled in the real locale JSON would
 * otherwise ship silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initI18n } from '@tracearr/translations';
import type { SetupStatus } from '@tracearr/shared';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    setup: { status: vi.fn() },
    auth: { validateClaimCode: vi.fn() },
  },
  BASE_URL: '/',
}));

vi.mock('@/lib/authClient', () => ({
  authClient: {
    $fetch: vi.fn(),
    signIn: { oauth2: vi.fn() },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { Login } from './Login';

const mockUseAuth = vi.mocked(useAuth);
const mockStatus = vi.mocked(api.setup.status);

const BASE_STATUS: SetupStatus = {
  needsSetup: true,
  requiresClaimCode: false,
  hasServers: false,
  hasJellyfinServers: false,
  hasPasswordAuth: true,
  authMethods: { local: true, plex: false, emby: true, oidc: false, oidcProviderName: null },
  embyAccountLinked: false,
};

describe('Login - real i18n resources (Emby setup keys)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n({ lng: 'en' });
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useAuth>);
    mockStatus.mockResolvedValue(BASE_STATUS);
  });

  afterEach(() => {
    cleanup();
  });

  it('resolves every new Emby-setup key to real English copy, with no console errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Tab labels and warning copy resolve to real strings, not raw i18n keys.
    expect(await screen.findByText('Set up with Emby')).toBeInTheDocument();
    expect(screen.getByText('Create local account')).toBeInTheDocument();
    expect(screen.getByText('Emby becomes your only way to sign in')).toBeInTheDocument();
    expect(screen.getByText(/pnpm reset-password/)).toBeInTheDocument();

    // None of the new keys leaked through unresolved (would render as "pages:login.embySetup...").
    expect(screen.queryByText(/pages:login\.embySetup/)).not.toBeInTheDocument();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
