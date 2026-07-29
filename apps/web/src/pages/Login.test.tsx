import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as ReactRouterModule from 'react-router';
import type * as ReactQueryModule from '@tanstack/react-query';
import type { SetupStatus } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && 'provider' in options) return `${key}:${String(options.provider)}`;
      return key;
    },
  }),
}));

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

import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { authClient } from '@/lib/authClient';
import { Login } from './Login';

const mockUseAuth = vi.mocked(useAuth);
const mockStatus = vi.mocked(api.setup.status);
const mockFetch = vi.mocked(authClient.$fetch);

const BASE_STATUS: SetupStatus = {
  needsSetup: true,
  requiresClaimCode: false,
  hasServers: false,
  hasJellyfinServers: false,
  hasPasswordAuth: true,
  authMethods: { local: true, plex: false, emby: true, oidc: false, oidcProviderName: null },
};

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe('Login - Emby-native first-run setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useAuth>);
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
