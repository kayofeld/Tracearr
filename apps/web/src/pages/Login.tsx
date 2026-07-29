import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  User,
  KeyRound,
  LogIn,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { authClient } from '@/lib/authClient';
import { api, BASE_URL } from '@/lib/api';
import {
  SIGN_UP_USERNAME_PATH,
  EMBY_LOGIN_PATH,
  EMBY_LOGIN_FAILURE_REASONS,
  type SetupStatus,
} from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';
import { cn } from '@/lib/utils';

const DEFAULT_AUTH_METHODS: SetupStatus['authMethods'] = {
  local: true,
  plex: false,
  emby: true,
  oidc: false,
  oidcProviderName: null,
};

// A narrowed callable shape for `t()` - the real TFunction's generic overloads
// make it awkward to pass around as a parameter type (mirrors the same
// narrowing used in OmbiSettings.tsx / NeverWatched.tsx / SeerrSettings.tsx).
type Translate = (key: string) => string;

// Our own copy per POST /emby/login failure `code` (EmbyLoginFailureReason,
// @tracearr/shared) - never string-match the server's prose. `INVALID_CREDENTIALS`
// is the server's own undifferentiated fallback (diagnosis unavailable/inconclusive);
// it maps to the same generic message an unrecognized/missing code falls back to.
//
// Deliberately not an exhaustive map over every `EmbyLoginFailureReason`: a
// locked-out Emby account must never be reported on this public page (it would
// confirm to an attacker that they succeeded in locking the owner out of their
// own Emby server), so that reason has no entry here and falls through to the
// generic message like any other unrecognized code. Left untyped (inferred)
// rather than annotated as `Record<EmbyLoginFailureReason, string>` so the map
// only ever claims the keys it actually lists.
const EMBY_ERROR_MESSAGE_KEYS = {
  [EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND]: 'pages:login.embyErrorUserNotFound',
  [EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD]: 'pages:login.embyErrorInvalidPassword',
  [EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED]: 'pages:login.embyErrorAccountDisabled',
  [EMBY_LOGIN_FAILURE_REASONS.INVALID_CREDENTIALS]: 'pages:login.embyLoginFailed',
} as const;

// `code in EMBY_ERROR_MESSAGE_KEYS` would walk the prototype chain, so a code
// of `toString` or `constructor` would pass and hand an inherited function to
// `t()`. An own-property check (the Object.hasOwn-equivalent
// `Object.prototype.hasOwnProperty.call` - the app's ES2020 lib target here
// doesn't yet expose the ES2022 `Object.hasOwn` global) restricts the check
// to the object's own keys.
function isEmbyLoginFailureReason(code: unknown): code is keyof typeof EMBY_ERROR_MESSAGE_KEYS {
  return (
    typeof code === 'string' && Object.prototype.hasOwnProperty.call(EMBY_ERROR_MESSAGE_KEYS, code)
  );
}

/** Render our own copy per failure code - never string-match the server's prose. */
function resolveEmbyLoginErrorMessage(
  error: { code?: unknown; message?: string } | null | undefined,
  t: Translate
): string {
  if (isEmbyLoginFailureReason(error?.code)) {
    return t(EMBY_ERROR_MESSAGE_KEYS[error.code]);
  }
  return error?.message || t('pages:login.embyLoginFailed');
}

type AuthStep = 'claim-code-gate' | 'initial';

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslation(['pages', 'common', 'settings', 'notifications']);
  // Narrowed shape used by the module-level resolveEmbyLoginErrorMessage - the
  // real TFunction's overloaded generics don't structurally reduce to
  // `Translate` cleanly (mirrors OmbiSettings.tsx / NeverWatched.tsx / SeerrSettings.tsx).
  const translate = t as unknown as Translate;
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  // Setup status - default to false (Sign In mode) since most users are returning
  const [setupLoading, setSetupLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [requiresClaimCode, setRequiresClaimCode] = useState(false);
  const [authMethods, setAuthMethods] = useState<SetupStatus['authMethods']>(DEFAULT_AUTH_METHODS);
  // Whether the owner already has a bound Emby identity (SetupStatus.embyAccountLinked).
  // Defaults to false (today's unchanged behavior) until the status fetch resolves.
  const [ownerEmbyLinked, setOwnerEmbyLinked] = useState(false);
  // "Other sign-in options" disclosure - collapsed by default when the owner
  // has a linked Emby account (the escape hatch stays reachable, not removed).
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false);

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
  const [embyFormError, setEmbyFormError] = useState<string | null>(null);

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
          setOwnerEmbyLinked(status.embyAccountLinked);

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
    setEmbyFormError(null);
    setEmbyPending(true);

    try {
      const { error } = await authClient.$fetch(EMBY_LOGIN_PATH, {
        method: 'POST',
        body: {
          username: embyUsername.trim(),
          password: embyPassword,
        },
      });

      if (error) {
        setEmbyFormError(resolveEmbyLoginErrorMessage(error, translate));
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
  // Once the owner has linked their Emby account, lead with Emby only and
  // move every other enabled method behind a collapsed disclosure - kept
  // reachable, not removed, since Emby login is a live passthrough and local
  // sign-in is the only way in when the Emby server itself is unreachable.
  const focusedEmbyMode = showEmbyLogin && ownerEmbyLinked;
  const otherMethodsAvailable = authMethods.oidc || authMethods.local;
  const hasPrimaryMethods = showEmbyLogin || authMethods.oidc;

  const embyForm = showEmbyLogin && (
    <form onSubmit={handleEmbyLogin} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="emby-username">{t('pages:login.embyUsername')}</Label>
        <Input
          id="emby-username"
          name="emby-username"
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
          name="emby-password"
          type="password"
          autoComplete="current-password"
          value={embyPassword}
          onChange={(e) => setEmbyPassword(e.target.value)}
          required
          disabled={embyPending}
        />
      </div>
      {embyFormError && (
        <p className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {embyFormError}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={embyPending}>
        {embyPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MediaServerIcon type="emby" className="mr-2 h-4 w-4" />
        )}
        {t('pages:login.signInWithEmby')}
      </Button>
    </form>
  );

  const oidcButton = authMethods.oidc && (
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
  );

  const methodsDivider = (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-card text-muted-foreground px-2">{t('common:or')}</span>
      </div>
    </div>
  );

  const localBlock = authMethods.local ? (
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

          {focusedEmbyMode ? (
            <>
              {embyForm}
              {otherMethodsAvailable ? (
                <Collapsible open={otherOptionsOpen} onOpenChange={setOtherOptionsOpen}>
                  <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]">
                    {t('pages:login.otherSignInOptions')}
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        otherOptionsOpen && 'rotate-180'
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-4 pt-4">
                    {oidcButton}
                    {authMethods.oidc && authMethods.local && methodsDivider}
                    {localBlock}
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                // No other method is enabled server-side, so there is nothing
                // to disclose - but the user still deserves to know why local
                // sign-in isn't offered here (same hint localBlock would show).
                <p className="text-muted-foreground text-center text-sm">
                  {t('pages:login.localDisabledHint')}
                </p>
              )}
            </>
          ) : (
            <>
              {embyForm}
              {oidcButton}
              {hasPrimaryMethods && methodsDivider}
              {localBlock}
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-xs">
        {needsSetup ? t('pages:login.setupNote') : t('pages:login.tagline')}
      </p>
    </div>
  );
}
