import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, User, KeyRound, LogIn, AlertCircle, AlertTriangle } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { authClient } from '@/lib/authClient';
import { api, BASE_URL } from '@/lib/api';
import { SIGN_UP_USERNAME_PATH, type SetupStatus } from '@tracearr/shared';
// EMBY_SETUP_PATH / EmbySetupErrorCode are re-exported from '@tracearr/shared' by this module,
// which also carries web-only presentation helpers (error-code -> field-group mapping) that are
// not part of the frozen contract itself. See apps/web/src/lib/embySetupContract.ts.
import {
  EMBY_SETUP_PATH,
  EMBY_SETUP_ERROR_GROUP,
  toEmbySetupErrorCode,
  type EmbySetupErrorCode,
} from '@/lib/embySetupContract';
import { LogoIcon } from '@/components/brand/Logo';

// A narrowed callable shape for `t()` - the real TFunction's generic overloads make it awkward
// to pass around as a parameter type (mirrors the same narrowing used in OmbiSettings.tsx and
// NeverWatched.tsx).
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * One message per `EmbySetupErrorCode` member, exhaustively. Adding a member to the union without
 * adding a case here is a compile error rather than a silently blank error box (design doc section
 * 14, item 3, mirror 2). Copy is fixed client-side per code - never the server's prose (SEC-03c).
 */
function embySetupErrorMessage(t: Translate, code: EmbySetupErrorCode): string {
  switch (code) {
    case 'CLAIM_CODE':
      return t('pages:login.embySetupError.claimCode');
    case 'INSTANCE_OWNED':
      return t('pages:login.embySetupError.instanceOwned');
    case 'INSTANCE_RECOVERY':
      return t('pages:login.embySetupError.instanceRecovery');
    case 'URL_REJECTED':
      return t('pages:login.embySetupError.urlRejected');
    case 'SERVER_UNREACHABLE':
      return t('pages:login.embySetupError.serverUnreachable');
    case 'KEY_REJECTED':
      return t('pages:login.embySetupError.keyRejected');
    case 'KEY_NOT_ADMIN':
      return t('pages:login.embySetupError.keyNotAdmin');
    case 'BAD_CREDENTIALS':
      return t('pages:login.embySetupError.badCredentials');
    case 'NOT_EMBY_ADMIN':
      return t('pages:login.embySetupError.notEmbyAdmin');
    case 'BUSY':
      return t('pages:login.embySetupError.busy');
    case 'SETUP_FAILED':
      return t('pages:login.embySetupError.setupFailed');
  }
}

const DEFAULT_AUTH_METHODS: SetupStatus['authMethods'] = {
  local: true,
  plex: false,
  emby: true,
  oidc: false,
  oidcProviderName: null,
};

type AuthStep = 'claim-code-gate' | 'initial';

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslation(['pages', 'common', 'settings', 'notifications']);
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  // Setup status - default to false (Sign In mode) since most users are returning
  const [setupLoading, setSetupLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [requiresClaimCode, setRequiresClaimCode] = useState(false);
  const [authMethods, setAuthMethods] = useState<SetupStatus['authMethods']>(DEFAULT_AUTH_METHODS);

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('initial');

  // Local auth form state (sign-in uses a single identifier field; sign-up
  // collects a display name and a separate login username)
  const [localPending, setLocalPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [email, setEmail] = useState('');

  // Emby credential login state
  const [embyUsername, setEmbyUsername] = useState('');
  const [embyPassword, setEmbyPassword] = useState('');
  const [embyPending, setEmbyPending] = useState(false);

  // First-run mode toggle: Emby-native setup vs local account creation. Emby is offered
  // first when available (design doc section 6.5).
  const [signupMode, setSignupMode] = useState<'emby' | 'local'>('emby');

  // Emby-native first-run setup state (creates the owner account from Emby credentials,
  // no separate local password - design doc section 6).
  const [embySetupServerUrl, setEmbySetupServerUrl] = useState('');
  const [embySetupServerName, setEmbySetupServerName] = useState('');
  const [embySetupApiKey, setEmbySetupApiKey] = useState('');
  const [embySetupUsername, setEmbySetupUsername] = useState('');
  const [embySetupPassword, setEmbySetupPassword] = useState('');
  const [embySetupPending, setEmbySetupPending] = useState(false);
  const [embySetupServerError, setEmbySetupServerError] = useState<string | null>(null);
  const [embySetupCredentialError, setEmbySetupCredentialError] = useState<string | null>(null);
  const [embySetupFormError, setEmbySetupFormError] = useState<string | null>(null);

  // OIDC state
  const [oidcPending, setOidcPending] = useState(false);
  const [oidcError, setOidcError] = useState<string | null>(null);

  // Claim code gate state
  const [claimCode, setClaimCode] = useState('');
  const [claimCodeLoading, setClaimCodeLoading] = useState(false);

  // Check setup status on mount with retry logic for server restarts
  useEffect(() => {
    async function checkSetup() {
      const maxRetries = 3;
      const delays = [0, 1000, 2000]; // immediate, 1s, 2s

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          }
          const status = await api.setup.status();
          setNeedsSetup(status.needsSetup);
          setRequiresClaimCode(status.requiresClaimCode);
          setAuthMethods(status.authMethods);

          // Set initial auth step based on setup requirements
          if (status.needsSetup && status.requiresClaimCode) {
            setAuthStep('claim-code-gate');
          }

          setSetupLoading(false);
          return; // Success - exit retry loop
        } catch {
          // Continue to next retry attempt
        }
      }

      // All retries failed - server is unavailable
      // Default to Sign In mode (needsSetup: false) since most users are returning users
      // If they actually need setup, the server will tell them when it comes back
      setNeedsSetup(false);
      setSetupLoading(false);
    }
    void checkSetup();
  }, []);

  // Surface OIDC callback errors (redirected here as /login?error=<code>)
  useEffect(() => {
    if (searchParams.get('error')) {
      setOidcError(t('pages:login.oidcError'));
    }
  }, [searchParams, t]);

  // Redirect if already authenticated
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      const redirectTo = searchParams.get('redirect') || '/';
      void navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, searchParams]);

  // Handle claim code validation (immediate feedback, server validates again during signup)
  const handleClaimCodeValidation = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setClaimCodeLoading(true);

    try {
      await api.auth.validateClaimCode({ claimCode: claimCode.trim() });
      toast.success(t('notifications:toast.success.claimCodeValidated.title'), {
        description: t('notifications:toast.success.claimCodeValidated.message'),
      });
      setAuthStep('initial');
    } catch (error) {
      toast.error(t('notifications:toast.error.invalidClaimCode.title'), {
        description:
          error instanceof Error
            ? error.message
            : t('notifications:toast.error.invalidClaimCode.message'),
      });
    } finally {
      setClaimCodeLoading(false);
    }
  };

  // Handle local sign-up (first-run owner account creation)
  const handleSignUp = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setLocalPending(true);

    try {
      // /sign-up/username (signupPlugin.ts) is the only local sign-up path:
      // email is optional there, unlike Better Auth's built-in
      // /sign-up/email which hard-requires one. The typed client only
      // accepts declared additionalFields, so this posts through $fetch
      // (the server schema accepts the arbitrary extra fields it needs).
      const trimmedEmail = email.trim();
      const { error } = await authClient.$fetch(SIGN_UP_USERNAME_PATH, {
        method: 'POST',
        body: {
          name: name.trim(),
          username: signupUsername.trim().toLowerCase(),
          ...(trimmedEmail && { email: trimmedEmail }),
          password,
          ...(requiresClaimCode && { claimCode: claimCode.trim() }),
        },
      });

      if (error) {
        setFormError(error.message ?? t('pages:login.createAccountFailed'));
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success(t('notifications:toast.success.loggedIn.title'), {
        description: t('pages:login.accountCreated'),
      });
      void navigate('/');
    } finally {
      setLocalPending(false);
    }
  };

  // Handle local sign-in - identifier can be an email or a username
  const handleSignIn = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setLocalPending(true);

    try {
      const trimmedIdentifier = identifier.trim();
      const call = trimmedIdentifier.includes('@')
        ? authClient.signIn.email({ email: trimmedIdentifier, password })
        : authClient.signIn.username({ username: trimmedIdentifier.toLowerCase(), password });
      const { error } = await call;

      if (error) {
        setFormError(error.message ?? t('pages:login.invalidCredentials'));
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success(t('notifications:toast.success.loggedIn.title'), {
        description: t('notifications:toast.success.loggedIn.message'),
      });
      void navigate('/');
    } finally {
      setLocalPending(false);
    }
  };

  // Handle Emby credential sign-in (owner logs in with their Emby admin account).
  const handleEmbyLogin = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setEmbyPending(true);

    try {
      const { error } = await authClient.$fetch('/emby/login', {
        method: 'POST',
        body: {
          username: embyUsername.trim(),
          password: embyPassword,
          ...(requiresClaimCode && { claimCode: claimCode.trim() }),
        },
      });

      if (error) {
        setFormError(error.message ?? t('pages:login.embyLoginFailed'));
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success(t('notifications:toast.success.loggedIn.title'), {
        description: t('notifications:toast.success.loggedIn.message'),
      });
      void navigate('/');
    } finally {
      setEmbyPending(false);
    }
  };

  // Handle Emby-native first-run setup: creates the owner account from the operator's own
  // Emby server, admin API key, and Emby credentials. No local password is ever set (design
  // doc section 6.2). Never logs or echoes apiKey/password; they only ever go in this POST body.
  const handleEmbySetup = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setEmbySetupServerError(null);
    setEmbySetupCredentialError(null);
    setEmbySetupFormError(null);
    setEmbySetupPending(true);

    try {
      const trimmedServerName = embySetupServerName.trim();
      const { error } = await authClient.$fetch(EMBY_SETUP_PATH, {
        method: 'POST',
        body: {
          serverUrl: embySetupServerUrl.trim(),
          ...(trimmedServerName && { serverName: trimmedServerName }),
          apiKey: embySetupApiKey,
          username: embySetupUsername.trim(),
          password: embySetupPassword,
          ...(requiresClaimCode && { claimCode: claimCode.trim() }),
        },
      });

      if (error) {
        const code = toEmbySetupErrorCode((error as { code?: unknown }).code);
        const message = code
          ? embySetupErrorMessage(t as unknown as Translate, code)
          : (error.message ?? t('pages:login.embySetupError.setupFailed'));
        const group = code ? EMBY_SETUP_ERROR_GROUP[code] : 'form';
        if (group === 'server') setEmbySetupServerError(message);
        else if (group === 'credentials') setEmbySetupCredentialError(message);
        else setEmbySetupFormError(message);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success(t('notifications:toast.success.loggedIn.title'), {
        description: t('pages:login.accountCreated'),
      });
      void navigate('/');
    } finally {
      setEmbySetupPending(false);
    }
  };

  // Handle OIDC sign-in - redirects the browser to the provider on success
  const handleOidcLogin = async () => {
    setOidcPending(true);
    setOidcError(null);

    const { error } = await authClient.signIn.oauth2({
      providerId: 'oidc',
      callbackURL: BASE_URL,
      errorCallbackURL: `${BASE_URL}login`,
      ...(requiresClaimCode && { additionalData: { claimCode: claimCode.trim() } }),
    });

    if (error) {
      setOidcError(error.message ?? t('pages:login.oidcError'));
      setOidcPending(false);
    }
  };

  // Show loading while checking auth/setup status
  if (authLoading || setupLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <LogoIcon className="h-16 w-16 animate-pulse" />
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  // Claim code gate - shown before any setup options
  if (authStep === 'claim-code-gate') {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="mb-4 h-20 w-20" />
          <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
          <p className="text-muted-foreground mt-2">{t('pages:login.claimCodeRequired')}</p>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              {t('pages:login.enterClaimCode')}
            </CardTitle>
            <CardDescription>{t('pages:login.claimCodeDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleClaimCodeValidation} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="gate-claimCode">
                  {t('pages:login.claimCodeLabel')}
                  <span className="text-destructive ml-1">*</span>
                </Label>
                <Input
                  id="gate-claimCode"
                  type="text"
                  placeholder=""
                  value={claimCode}
                  onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                  required
                  disabled={claimCodeLoading}
                  className="font-mono text-lg tracking-wider"
                  autoFocus
                />
                <p className="text-muted-foreground text-xs">{t('pages:login.claimCodeHint')}</p>
              </div>
              <Button type="submit" className="w-full" disabled={claimCodeLoading}>
                {claimCodeLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                {t('pages:login.validateClaimCode')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-muted-foreground mt-6 text-center text-xs">
          {t('pages:login.claimCodeSecurityNote')}
        </p>
      </div>
    );
  }

  // Emby credential login is offered for returning sign-in (an owner + Emby
  // server already exist).
  const showEmbyLogin = authMethods.emby && !needsSetup;
  const hasPrimaryMethods = showEmbyLogin || authMethods.oidc;

  // First-run setup offers Emby-native setup and/or local account creation, whichever the
  // instance's auth methods allow (design doc section 6.5). Emby is listed first when both
  // are available.
  const showEmbySetup = needsSetup && authMethods.emby;
  const showLocalSetup = needsSetup && authMethods.local;
  const showSetupModeToggle = showEmbySetup && showLocalSetup;

  const embySetupForm = (
    <form
      onSubmit={handleEmbySetup}
      className="space-y-4"
      aria-label={t('pages:login.embySetupTab')}
    >
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('pages:login.embySetupWarningTitle')}</AlertTitle>
        <AlertDescription>{t('pages:login.embySetupWarningBody')}</AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="emby-setup-server-url">{t('settings:servers.serverUrl')}</Label>
        <Input
          id="emby-setup-server-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder={t('settings:servers.serverUrlPlaceholder')}
          value={embySetupServerUrl}
          onChange={(e) => setEmbySetupServerUrl(e.target.value)}
          required
          disabled={embySetupPending}
          aria-invalid={!!embySetupServerError}
          aria-describedby="emby-setup-server-url-hint"
        />
        <p id="emby-setup-server-url-hint" className="text-muted-foreground text-xs">
          {t('settings:servers.serverUrlHelpEmby')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="emby-setup-server-name">
          {t('pages:login.embySetupServerNameOptionalLabel')}
        </Label>
        <Input
          id="emby-setup-server-name"
          type="text"
          autoComplete="off"
          placeholder={t('settings:servers.serverNamePlaceholder')}
          value={embySetupServerName}
          onChange={(e) => setEmbySetupServerName(e.target.value)}
          disabled={embySetupPending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="emby-setup-api-key">{t('common:labels.apiKey')}</Label>
        <PasswordInput
          id="emby-setup-api-key"
          autoComplete="off"
          placeholder={t('settings:servers.apiKeyPlaceholder')}
          value={embySetupApiKey}
          onChange={(e) => setEmbySetupApiKey(e.target.value)}
          required
          disabled={embySetupPending}
          aria-invalid={!!embySetupServerError}
          aria-describedby="emby-setup-api-key-hint"
        />
        <p id="emby-setup-api-key-hint" className="text-muted-foreground text-xs">
          {t('settings:servers.apiKeyHelpEmby')}
        </p>
      </div>

      {embySetupServerError && (
        <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {embySetupServerError}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="emby-setup-username">{t('pages:login.embyUsername')}</Label>
        <Input
          id="emby-setup-username"
          type="text"
          autoComplete="username"
          value={embySetupUsername}
          onChange={(e) => setEmbySetupUsername(e.target.value)}
          required
          disabled={embySetupPending}
          aria-invalid={!!embySetupCredentialError}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="emby-setup-password">{t('settings:account.password')}</Label>
        <PasswordInput
          id="emby-setup-password"
          autoComplete="current-password"
          value={embySetupPassword}
          onChange={(e) => setEmbySetupPassword(e.target.value)}
          required
          disabled={embySetupPending}
          aria-invalid={!!embySetupCredentialError}
        />
      </div>

      {embySetupCredentialError && (
        <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {embySetupCredentialError}
        </p>
      )}

      {embySetupFormError && (
        <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {embySetupFormError}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={embySetupPending}>
        {embySetupPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MediaServerIcon type="emby" className="mr-2 h-4 w-4" />
        )}
        {t('pages:login.completeEmbySetup')}
      </Button>
    </form>
  );

  const localSignupForm = (
    <form onSubmit={handleSignUp} className="space-y-4" aria-label={t('pages:login.localSetupTab')}>
      <div className="space-y-2">
        <Label htmlFor="name">{t('settings:account.displayName')}</Label>
        <Input
          id="name"
          type="text"
          autoComplete="name"
          placeholder={t('pages:login.displayNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="username">{t('pages:login.username')}</Label>
        <Input
          id="username"
          type="text"
          autoComplete="username"
          placeholder={t('pages:login.usernamePlaceholder')}
          value={signupUsername}
          onChange={(e) => setSignupUsername(e.target.value)}
          required
          minLength={3}
          maxLength={30}
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">{t('pages:login.emailOptionalLabel')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={t('pages:login.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={localPending}
        />
        <p className="text-muted-foreground text-xs">{t('pages:login.emailOptionalHint')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('settings:account.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder={t('pages:login.passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          disabled={localPending}
        />
      </div>
      {formError && (
        <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {formError}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={localPending}>
        {localPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <User className="mr-2 h-4 w-4" />
        )}
        {t('settings:account.createAccount')}
      </Button>
    </form>
  );

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoIcon className="mb-4 h-20 w-20" />
        <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
        <p className="text-muted-foreground mt-2">
          {needsSetup ? t('pages:login.createAccountHeading') : t('pages:login.signInHeading')}
        </p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {needsSetup
              ? showEmbySetup && (!showSetupModeToggle || signupMode === 'emby')
                ? t('pages:login.embySetupTitle')
                : t('settings:account.createAccount')
              : t('common:actions.signIn')}
          </CardTitle>
          <CardDescription>
            {needsSetup
              ? showEmbySetup && (!showSetupModeToggle || signupMode === 'emby')
                ? t('pages:login.embySetupDescription')
                : t('pages:login.createAccountDescription')
              : t('pages:login.signInDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {oidcError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{oidcError}</AlertDescription>
            </Alert>
          )}

          <>
            {showEmbyLogin && (
              <form onSubmit={handleEmbyLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="emby-username">{t('pages:login.embyUsername')}</Label>
                  <Input
                    id="emby-username"
                    type="text"
                    autoComplete="username"
                    value={embyUsername}
                    onChange={(e) => setEmbyUsername(e.target.value)}
                    required
                    disabled={embyPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emby-password">{t('settings:account.password')}</Label>
                  <Input
                    id="emby-password"
                    type="password"
                    autoComplete="current-password"
                    value={embyPassword}
                    onChange={(e) => setEmbyPassword(e.target.value)}
                    required
                    disabled={embyPending}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={embyPending}>
                  {embyPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <MediaServerIcon type="emby" className="mr-2 h-4 w-4" />
                  )}
                  {t('pages:login.signInWithEmby')}
                </Button>
              </form>
            )}

            {authMethods.oidc && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={oidcPending}
                onClick={handleOidcLogin}
              >
                {oidcPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="mr-2 h-4 w-4" />
                )}
                {t('pages:login.continueWith', { provider: authMethods.oidcProviderName })}
              </Button>
            )}

            {hasPrimaryMethods && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card text-muted-foreground px-2">{t('common:or')}</span>
                </div>
              </div>
            )}

            {needsSetup ? (
              showSetupModeToggle ? (
                <Tabs
                  value={signupMode}
                  onValueChange={(value) => setSignupMode(value === 'local' ? 'local' : 'emby')}
                  className="w-full"
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="emby">{t('pages:login.embySetupTab')}</TabsTrigger>
                    <TabsTrigger value="local">{t('pages:login.localSetupTab')}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="emby" className="pt-4">
                    {embySetupForm}
                  </TabsContent>
                  <TabsContent value="local" className="pt-4">
                    {localSignupForm}
                  </TabsContent>
                </Tabs>
              ) : showEmbySetup ? (
                embySetupForm
              ) : authMethods.local ? (
                localSignupForm
              ) : (
                <p className="text-muted-foreground text-center text-sm">
                  {t('pages:login.localDisabledHint')}
                </p>
              )
            ) : authMethods.local ? (
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="identifier">{t('pages:login.usernameOrEmail')}</Label>
                  <Input
                    id="identifier"
                    type="text"
                    autoComplete="username"
                    placeholder={t('pages:login.identifierPlaceholder')}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                    disabled={localPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">{t('settings:account.password')}</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('pages:login.yourPasswordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={localPending}
                  />
                </div>
                {formError && (
                  <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {formError}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={localPending}>
                  {localPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  {t('common:actions.signIn')}
                </Button>
              </form>
            ) : (
              <p className="text-muted-foreground text-center text-sm">
                {t('pages:login.localDisabledHint')}
              </p>
            )}
          </>
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-xs">
        {needsSetup
          ? showEmbySetup && (!showSetupModeToggle || signupMode === 'emby')
            ? t('pages:login.embySetupNote')
            : t('pages:login.setupNote')
          : t('pages:login.tagline')}
      </p>
    </div>
  );
}
