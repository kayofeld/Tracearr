import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as ReactRouterModule from 'react-router';
import type * as ReactQueryModule from '@tanstack/react-query';
import { EMBY_LOGIN_FAILURE_REASONS, type SetupStatus } from '@tracearr/shared';

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

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouterModule>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams()],
  };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof ReactQueryModule>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { authClient } from '@/lib/authClient';
import { Login } from './Login';

const mockStatus = vi.mocked(api.setup.status);
const mockFetch = vi.mocked(authClient.$fetch);

const BASE_STATUS: SetupStatus = {
  needsSetup: true,
  requiresClaimCode: false,
  hasServers: false,
  hasJellyfinServers: false,
  hasPasswordAuth: true,
  authMethods: { local: true, plex: false, emby: true, oidc: false, oidcProviderName: null },
  embyAccountLinked: false,
};

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
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
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

describe('Login - Emby-native first-run setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus.mockResolvedValue(BASE_STATUS);
  });

  it('offers Emby setup first, alongside local account creation, on a fresh instance', async () => {
    renderLogin();

    expect(await screen.findByRole('tab', { name: 'pages:login.embySetupTab' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: 'pages:login.localSetupTab' })).toBeInTheDocument();
  });

  it('shows the lockout warning prominently in the Emby setup form', async () => {
    renderLogin();

    expect(await screen.findByText('pages:login.embySetupWarningTitle')).toBeInTheDocument();
    expect(screen.getByText('pages:login.embySetupWarningBody')).toBeInTheDocument();
  });

  it('keeps the local signup path working unchanged when only local is offered', async () => {
    mockStatus.mockResolvedValue({
      ...BASE_STATUS,
      authMethods: { ...BASE_STATUS.authMethods, emby: false },
    });
    renderLogin();

    expect(await screen.findByLabelText('settings:account.displayName')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'pages:login.embySetupTab' })).not.toBeInTheDocument();
    expect(screen.queryByText('pages:login.embySetupWarningTitle')).not.toBeInTheDocument();
  });

  it('renders only the Emby setup form (no mode toggle) when local signup is disabled', async () => {
    mockStatus.mockResolvedValue({
      ...BASE_STATUS,
      authMethods: { ...BASE_STATUS.authMethods, local: false },
    });
    renderLogin();

    expect(await screen.findByText('pages:login.embySetupWarningTitle')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'pages:login.embySetupTab' })).not.toBeInTheDocument();
  });

  it('submits the Emby setup form with the server, key, and credentials, and never puts secrets in a query string', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ data: { authorized: true }, error: null });
    renderLogin();

    await user.type(
      await screen.findByLabelText('settings:servers.serverUrl'),
      'http://192.168.1.10:8096'
    );
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'super-secret-key');
    await user.type(screen.getByLabelText('pages:login.embyUsername'), 'admin');
    await user.type(screen.getByLabelText('settings:account.password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: /pages:login.completeEmbySetup/ }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [path, init] = call as NonNullable<typeof call>;
    expect(path).toBe('/emby/setup');
    expect(init).toMatchObject({
      method: 'POST',
      body: {
        serverUrl: 'http://192.168.1.10:8096',
        apiKey: 'super-secret-key',
        username: 'admin',
        password: 'hunter2',
      },
    });
    // Secrets travel only in the POST body of a same-path fetch call - never appended to a URL.
    expect(String(path)).not.toContain('super-secret-key');
    expect(String(path)).not.toContain('hunter2');

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
  });

  it('renders a server-group error for URL_REJECTED without echoing server prose', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      data: null,
      error: { code: 'URL_REJECTED', message: 'raw upstream detail should not be shown' },
    });
    renderLogin();

    await user.type(
      await screen.findByLabelText('settings:servers.serverUrl'),
      'http://169.254.169.254'
    );
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'key');
    await user.type(screen.getByLabelText('pages:login.embyUsername'), 'admin');
    await user.type(screen.getByLabelText('settings:account.password'), 'pw');
    await user.click(screen.getByRole('button', { name: /pages:login.completeEmbySetup/ }));

    expect(await screen.findByText('pages:login.embySetupError.urlRejected')).toBeInTheDocument();
    expect(screen.queryByText('raw upstream detail should not be shown')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // Server-group codes mark the server/key fields invalid, not the credential fields
    // (design doc section 6.4's field-group targeting).
    expect(screen.getByLabelText('settings:servers.serverUrl')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByLabelText('pages:login.embyUsername')).toHaveAttribute(
      'aria-invalid',
      'false'
    );
  });

  it('renders a credentials-group error for BAD_CREDENTIALS', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      data: null,
      error: { code: 'BAD_CREDENTIALS', message: 'ignored' },
    });
    renderLogin();

    await user.type(
      await screen.findByLabelText('settings:servers.serverUrl'),
      'http://192.168.1.10:8096'
    );
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'key');
    await user.type(screen.getByLabelText('pages:login.embyUsername'), 'admin');
    await user.type(screen.getByLabelText('settings:account.password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /pages:login.completeEmbySetup/ }));

    expect(
      await screen.findByText('pages:login.embySetupError.badCredentials')
    ).toBeInTheDocument();
    // Credentials-group codes mark username/password invalid, not the server/key fields.
    expect(screen.getByLabelText('pages:login.embyUsername')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByLabelText('settings:servers.serverUrl')).toHaveAttribute(
      'aria-invalid',
      'false'
    );
  });

  it('renders a whole-form error for INSTANCE_RECOVERY', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      data: null,
      error: { code: 'INSTANCE_RECOVERY', message: 'ignored' },
    });
    renderLogin();

    await user.type(
      await screen.findByLabelText('settings:servers.serverUrl'),
      'http://192.168.1.10:8096'
    );
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'key');
    await user.type(screen.getByLabelText('pages:login.embyUsername'), 'admin');
    await user.type(screen.getByLabelText('settings:account.password'), 'pw');
    await user.click(screen.getByRole('button', { name: /pages:login.completeEmbySetup/ }));

    expect(
      await screen.findByText('pages:login.embySetupError.instanceRecovery')
    ).toBeInTheDocument();
  });

  it('falls back to a generic message when the error carries no recognized code', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      data: null,
      error: { message: 'network exploded' },
    });
    renderLogin();

    await user.type(
      await screen.findByLabelText('settings:servers.serverUrl'),
      'http://192.168.1.10:8096'
    );
    await user.type(screen.getByLabelText('common:labels.apiKey'), 'key');
    await user.type(screen.getByLabelText('pages:login.embyUsername'), 'admin');
    await user.type(screen.getByLabelText('settings:account.password'), 'pw');
    await user.click(screen.getByRole('button', { name: /pages:login.completeEmbySetup/ }));

    expect(await screen.findByText('network exploded')).toBeInTheDocument();
  });
});

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

  it('shows the disabled-login hint instead of the disclosure when there are no other enabled methods', async () => {
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

    // Nothing to disclose - no disclosure trigger.
    expect(
      screen.queryByRole('button', { name: 'pages:login.otherSignInOptions' })
    ).not.toBeInTheDocument();
    // But the user still gets an explanation for why no other method is offered.
    expect(screen.getByText('pages:login.localDisabledHint')).toBeInTheDocument();
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

  it('posts to the Emby login path with no claimCode field - the Emby form is never shown during setup, so a claim code can never apply', async () => {
    mockStatus.mockResolvedValue(baseStatus());
    mockFetch.mockResolvedValue({ data: {}, error: null });
    renderLogin();
    await waitForSetupLoaded();

    const scope = embyFormScope();
    await userEvent.type(screen.getByLabelText('pages:login.embyUsername'), 'owner');
    await userEvent.type(scope.getByLabelText('settings:account.password'), 'correct-password');
    await userEvent.click(scope.getByRole('button', { name: /pages:login.signInWithEmby/ }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Non-null: the assertion above already proved this call exists.
    const [path, options] = mockFetch.mock.calls[0]!;
    // The rate-limit matcher on the server keys off this exact path - it must
    // stay in sync with the shared EMBY_LOGIN_PATH constant, not a local literal.
    expect(path).toBe('/emby/login');
    expect(options?.body).toEqual({ username: 'owner', password: 'correct-password' });
    expect(options?.body).not.toHaveProperty('claimCode');
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

  it('never renders lockout-specific copy - a locked-out account must never be reported on this public page', async () => {
    mockStatus.mockResolvedValue(baseStatus());
    mockFetch.mockResolvedValue({
      data: null,
      // Literal string, not EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT - that
      // member no longer exists in the frozen contract. This guards against any
      // orphan lockout copy/key, regardless of whether a stray server ever sends
      // it. No `message` override, so a recognized code would fall through to
      // its own translated copy - here it must fall through to the generic key.
      error: { code: 'account_locked_out' },
    });
    renderLogin();
    await waitForSetupLoaded();

    await submitEmbyLogin();

    // Falls through to the generic message like any other unrecognized code -
    // never a lockout-specific message.
    expect(await screen.findByText('pages:login.embyLoginFailed')).toBeInTheDocument();
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
  });

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

  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'treats prototype-chain property name %s as an unrecognized code, not an inherited function',
    async (code) => {
      mockStatus.mockResolvedValue(baseStatus());
      // No `message` override: a `code in EMBY_ERROR_MESSAGE_KEYS` guard would
      // match these via the prototype chain, treat them as "recognized", and
      // hand the inherited Object.prototype member to `t()` instead of a
      // string key. The fixed Object.hasOwn guard treats them as unrecognized,
      // so this must fall through to the plain generic translated key.
      mockFetch.mockResolvedValue({ data: null, error: { code } });
      renderLogin();
      await waitForSetupLoaded();

      await submitEmbyLogin();

      expect(await screen.findByText('pages:login.embyLoginFailed')).toBeInTheDocument();
    }
  );
});
