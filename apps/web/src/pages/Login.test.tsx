import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EMBY_LOGIN_FAILURE_REASONS, type SetupStatus } from '@tracearr/shared';
import { Login } from './Login';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
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
    signIn: {
      email: vi.fn(),
      username: vi.fn(),
      oauth2: vi.fn(),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { authClient } from '@/lib/authClient';

const mockStatus = vi.mocked(api.setup.status);
const mockFetch = vi.mocked(authClient.$fetch);

function baseStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    needsSetup: false,
    requiresClaimCode: false,
    hasServers: true,
    hasJellyfinServers: false,
    hasPasswordAuth: true,
    authMethods: {
      local: true,
      plex: false,
      emby: true,
      oidc: false,
      oidcProviderName: null,
    },
    embyAccountLinked: false,
    ...overrides,
  };
}

function withEmbyLinked(status: SetupStatus, linked: boolean): SetupStatus {
  return { ...status, embyAccountLinked: linked };
}

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function waitForSetupLoaded() {
  await waitFor(() => expect(mockStatus).toHaveBeenCalled());
  await screen.findByLabelText('pages:login.embyUsername');
}

/** Scope queries to the Emby form - it and the local form both label their
 * password field `settings:account.password`, so an unscoped query is
 * ambiguous whenever both forms render at once (non-focused mode). */
function embyFormScope() {
  const usernameInput = screen.getByLabelText('pages:login.embyUsername');
  const form = usernameInput.closest('form');
  if (!form) throw new Error('Emby form not found');
  return within(form);
}

describe('Login - Emby-linked focused mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only the Emby form by default when the owner has a linked Emby account, with a collapsed disclosure for other methods', async () => {
    mockStatus.mockResolvedValue(withEmbyLinked(baseStatus(), true));
    renderLogin();
    await waitForSetupLoaded();

    // Emby form is present.
    expect(screen.getByLabelText('pages:login.embyUsername')).toBeInTheDocument();

    // Local sign-in is NOT visible by default.
    expect(screen.queryByLabelText('pages:login.usernameOrEmail')).not.toBeInTheDocument();

    // The disclosure trigger exists, collapsed.
    const trigger = screen.getByRole('button', { name: 'pages:login.otherSignInOptions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Expanding it (mouse) reveals the local form.
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('pages:login.usernameOrEmail')).toBeInTheDocument();
  });

  it('is keyboard-reachable: focusing the trigger and pressing Enter expands it', async () => {
    mockStatus.mockResolvedValue(withEmbyLinked(baseStatus(), true));
    renderLogin();
    await waitForSetupLoaded();

    const trigger = screen.getByRole('button', { name: 'pages:login.otherSignInOptions' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('pages:login.usernameOrEmail')).toBeInTheDocument();
  });

  it('does not render the disclosure at all when there are no other enabled methods', async () => {
    mockStatus.mockResolvedValue(
      withEmbyLinked(
        baseStatus({
          authMethods: {
            local: false,
            plex: false,
            emby: true,
            oidc: false,
            oidcProviderName: null,
          },
        }),
        true
      )
    );
    renderLogin();
    await waitForSetupLoaded();

    expect(
      screen.queryByRole('button', { name: 'pages:login.otherSignInOptions' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('pages:login.localDisabledHint')).not.toBeInTheDocument();
  });

  it('behaves exactly like today when the owner has no linked Emby account: all enabled methods shown together, no disclosure', async () => {
    mockStatus.mockResolvedValue(withEmbyLinked(baseStatus(), false));
    renderLogin();
    await waitForSetupLoaded();

    expect(screen.getByLabelText('pages:login.embyUsername')).toBeInTheDocument();
    expect(screen.getByLabelText('pages:login.usernameOrEmail')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'pages:login.otherSignInOptions' })
    ).not.toBeInTheDocument();
  });

  it('never shows a method disabled server-side, even in focused mode', async () => {
    mockStatus.mockResolvedValue(
      withEmbyLinked(
        baseStatus({
          authMethods: {
            local: false,
            plex: false,
            emby: true,
            oidc: true,
            oidcProviderName: 'Auth0',
          },
        }),
        true
      )
    );
    renderLogin();
    await waitForSetupLoaded();

    const trigger = screen.getByRole('button', { name: 'pages:login.otherSignInOptions' });
    await userEvent.click(trigger);

    expect(screen.getByText('pages:login.continueWith')).toBeInTheDocument();
    // Local is disabled server-side - never a form for it, only the existing
    // explanatory hint (unchanged pre-existing behavior).
    expect(screen.queryByLabelText('pages:login.usernameOrEmail')).not.toBeInTheDocument();
    expect(screen.getByText('pages:login.localDisabledHint')).toBeInTheDocument();
  });
});

describe('Login - Emby credential input hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets distinct name + correct autocomplete attributes on the Emby inputs', async () => {
    mockStatus.mockResolvedValue(baseStatus());
    renderLogin();
    await waitForSetupLoaded();

    const usernameInput = screen.getByLabelText('pages:login.embyUsername');
    expect(usernameInput).toHaveAttribute('name', 'emby-username');
    expect(usernameInput).toHaveAttribute('autocomplete', 'username');

    const passwordInput = embyFormScope().getByLabelText('settings:account.password');
    expect(passwordInput).toHaveAttribute('name', 'emby-password');
    expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
  });
});

describe('Login - Emby login failure reason codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function submitEmbyLogin() {
    const scope = embyFormScope();
    await userEvent.type(screen.getByLabelText('pages:login.embyUsername'), 'owner');
    await userEvent.type(scope.getByLabelText('settings:account.password'), 'wrong-password');
    await userEvent.click(scope.getByRole('button', { name: /pages:login.signInWithEmby/ }));
  }

  it.each([
    [EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND, 'pages:login.embyErrorUserNotFound'],
    [EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD, 'pages:login.embyErrorInvalidPassword'],
    [EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED, 'pages:login.embyErrorAccountDisabled'],
    [EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT, 'pages:login.embyErrorAccountLocked'],
    [EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS, 'pages:login.embyLoginFailed'],
  ] as const)(
    'renders its own copy for %s without string-matching server prose',
    async (code, key) => {
      mockStatus.mockResolvedValue(baseStatus());
      mockFetch.mockResolvedValue({
        data: null,
        error: { code, message: 'some unrelated server prose that must not be shown verbatim' },
      });
      renderLogin();
      await waitForSetupLoaded();

      await submitEmbyLogin();

      expect(await screen.findByText(key)).toBeInTheDocument();
      expect(
        screen.queryByText('some unrelated server prose that must not be shown verbatim')
      ).not.toBeInTheDocument();
    }
  );

  it('falls back to the server message when the code is missing (e.g. a connection error)', async () => {
    mockStatus.mockResolvedValue(baseStatus());
    mockFetch.mockResolvedValue({
      data: null,
      error: { message: 'Could not reach the Emby server.' },
    });
    renderLogin();
    await waitForSetupLoaded();

    await submitEmbyLogin();

    expect(await screen.findByText('Could not reach the Emby server.')).toBeInTheDocument();
  });

  it('falls back to the generic failure message when there is no code and no message', async () => {
    mockStatus.mockResolvedValue(baseStatus());
    mockFetch.mockResolvedValue({ data: null, error: {} });
    renderLogin();
    await waitForSetupLoaded();

    await submitEmbyLogin();

    expect(await screen.findByText('pages:login.embyLoginFailed')).toBeInTheDocument();
  });
});
