import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, User, KeyRound, LogIn, AlertCircle, AlertTriangle } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { authClient } from '@/lib/authClient';
import { api, BASE_URL } from '@/lib/api';
import type { SetupStatus } from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';

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
      // signUp.email's typed client only accepts declared additionalFields;
      // username and claimCode aren't declared there, so post through $fetch
      // (the server's sign-up/email schema accepts arbitrary extra fields).
      const { error } = await authClient.$fetch('/sign-up/email', {
        method: 'POST',
        body: {
          name: name.trim(),
          username: signupUsername.trim().toLowerCase(),
          email: email.trim(),
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
  // server already exist). First-run setup stays on local account creation.
  const showEmbyLogin = authMethods.emby && !needsSetup;
  const hasPrimaryMethods = showEmbyLogin || authMethods.oidc;

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
            {needsSetup ? t('settings:account.createAccount') : t('common:actions.signIn')}
          </CardTitle>
          <CardDescription>
            {needsSetup
              ? t('pages:login.createAccountDescription')
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

            {authMethods.local ? (
              needsSetup ? (
                <form onSubmit={handleSignUp} className="space-y-4">
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
                    <Label htmlFor="email">{t('settings:account.email')}</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder={t('pages:login.emailPlaceholder')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      disabled={localPending}
                    />
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
              ) : (
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
              )
            ) : (
              <p className="text-muted-foreground text-center text-sm">
                {t('pages:login.localDisabledHint')}
              </p>
            )}
          </>
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-xs">
        {needsSetup ? t('pages:login.setupNote') : t('pages:login.tagline')}
      </p>
    </div>
  );
}
