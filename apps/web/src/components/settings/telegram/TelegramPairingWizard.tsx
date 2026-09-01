import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Field, FieldLabel, FieldError, FieldDescription } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api } from '@/lib/api';
import type { TelegramPairingStart } from './telegramPairingContract';

// Telegram's own docs for creating a bot with BotFather - linked from step 1
// so a first-timer knows where the bot token comes from.
const TELEGRAM_BOT_DOCS_URL = 'https://core.telegram.org/bots#how-do-i-create-a-bot';
const POLL_INTERVAL_MS = 3000;

type WizardStep = 'token' | 'pair' | 'finishing';

export interface TelegramPairingWizardProps {
  /**
   * Called once the bot reports the code was sent (pairing state === 'paired').
   * Receives the validated bot token (from step 1) and the resolved chat id
   * (from the pairing status), so the caller can persist the agent through
   * the existing settings-update path. Rejecting keeps the wizard on the
   * finishing step with an inline retry.
   */
  onPaired: (result: { botToken: string; chatId: string }) => Promise<void>;
  /** Called when the user backs all the way out of the wizard (optional). */
  onCancel?: () => void;
}

function formatTimeLeft(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function TelegramPairingWizard({ onPaired }: TelegramPairingWizardProps) {
  const { t } = useTranslation(['pages', 'notifications', 'common']);

  const [step, setStep] = useState<WizardStep>('token');
  const [botToken, setBotToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [pairing, setPairing] = useState<TelegramPairingStart | null>(null);
  const [expired, setExpired] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const [chatId, setChatId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Guards against re-triggering the save automatically once it has been
  // attempted for a given chat id - a retry after that point is manual only.
  const attemptedChatIdRef = useRef<string | null>(null);
  // Latest pairing id + whether it resolved, read by the unmount cleanup so a
  // pairing left pending/expired is cancelled server-side (best effort).
  const cleanupStateRef = useRef<{ pairingId: string | null; resolved: boolean }>({
    pairingId: null,
    resolved: false,
  });

  useEffect(() => {
    cleanupStateRef.current = { pairingId: pairing?.pairingId ?? null, resolved: chatId !== null };
  }, [pairing, chatId]);

  useEffect(() => {
    return () => {
      const { pairingId, resolved } = cleanupStateRef.current;
      if (pairingId && !resolved) {
        api.telegramPairing.cancel(pairingId).catch(() => {
          // Best-effort cleanup - the pairing will lapse on its own via expiry.
        });
      }
    };
  }, []);

  // Local countdown for the code's expiry, independent of the status poll.
  useEffect(() => {
    if (step !== 'pair' || !pairing) {
      setTimeLeft(null);
      return;
    }

    const tick = () => {
      const remaining = Math.max(
        0,
        Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)
      );
      setTimeLeft(remaining);
      if (remaining === 0) setExpired(true);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [step, pairing]);

  // Poll the pairing status while step 2 is open. Stops automatically when
  // the component unmounts (react-query tears down the observer), and also
  // once the pairing resolves to 'paired' or 'expired'.
  const statusQuery = useQuery({
    queryKey: ['telegramPairingStatus', pairing?.pairingId],
    queryFn: () => api.telegramPairing.status(pairing?.pairingId ?? ''),
    enabled: step === 'pair' && !!pairing && !expired,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'paired' || state === 'expired' ? false : POLL_INTERVAL_MS;
    },
  });

  useEffect(() => {
    const data = statusQuery.data;
    if (!data) return;
    if (data.state === 'expired') {
      setExpired(true);
    } else if (data.state === 'paired' && data.chatId) {
      setChatId(data.chatId);
      setStep('finishing');
    }
  }, [statusQuery.data]);

  const runSave = useCallback(
    async (resolvedChatId: string) => {
      attemptedChatIdRef.current = resolvedChatId;
      setSaving(true);
      setSaveError(null);
      try {
        await onPaired({ botToken: botToken.trim(), chatId: resolvedChatId });
      } catch (err) {
        setSaveError(
          err instanceof Error
            ? err.message
            : t('pages:settings.notifications.telegramWizard.saveFailedError')
        );
      } finally {
        setSaving(false);
      }
    },
    [botToken, onPaired, t]
  );

  // Auto-attempt the save exactly once per resolved chat id.
  useEffect(() => {
    if (step === 'finishing' && chatId && attemptedChatIdRef.current !== chatId) {
      void runSave(chatId);
    }
  }, [step, chatId, runSave]);

  const handleStart = async () => {
    const trimmed = botToken.trim();
    if (!trimmed) {
      setTokenError(t('pages:settings.notifications.telegramWizard.botTokenRequired'));
      return;
    }

    setStarting(true);
    setTokenError(null);
    try {
      const result = await api.telegramPairing.start(trimmed);
      setPairing(result);
      setExpired(false);
      setStep('pair');
    } catch (err) {
      setTokenError(
        err instanceof Error
          ? err.message
          : t('pages:settings.notifications.telegramWizard.invalidTokenError')
      );
    } finally {
      setStarting(false);
    }
  };

  const handleStartOver = () => {
    if (pairing) {
      api.telegramPairing.cancel(pairing.pairingId).catch(() => {
        // Best-effort cleanup - the pairing will lapse on its own via expiry.
      });
    }
    setPairing(null);
    setExpired(false);
    setChatId(null);
    setSaveError(null);
    attemptedChatIdRef.current = null;
    setStep('token');
  };

  const handleCopyCode = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success(t('notifications:toast.success.tokenCopied.title'), {
        description: t('notifications:toast.success.tokenCopied.message'),
      });
    } catch {
      toast.error(t('notifications:toast.error.copyFailed'));
    }
  };

  const stepTitleKey =
    step === 'token'
      ? 'pages:settings.notifications.telegramWizard.step1Title'
      : step === 'pair'
        ? 'pages:settings.notifications.telegramWizard.step2Title'
        : 'pages:settings.notifications.telegramWizard.step3Title';
  const stepNumber = step === 'token' ? 1 : step === 'pair' ? 2 : 3;
  const stepAnnouncement = t('pages:settings.notifications.telegramWizard.stepAnnouncement', {
    step: stepNumber,
    total: 3,
    title: t(stepTitleKey),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Announces step changes to assistive tech - the visible chrome below
          conveys the same transition visually. */}
      <div aria-live="polite" className="sr-only">
        {stepAnnouncement}
      </div>

      {step === 'token' && (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.notifications.telegramWizard.step1Desc')}
          </p>
          <Field data-invalid={!!tokenError}>
            <FieldLabel htmlFor="telegram-bot-token">
              {t('pages:settings.notifications.telegramWizard.botTokenLabel')}
              <span className="text-destructive ml-1">*</span>
            </FieldLabel>
            <PasswordInput
              id="telegram-bot-token"
              placeholder="123456789:ABCdef..."
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value);
                if (tokenError) setTokenError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleStart();
                }
              }}
              aria-invalid={!!tokenError}
              aria-describedby="telegram-bot-token-help"
              autoComplete="off"
            />
            <FieldDescription id="telegram-bot-token-help">
              {t('pages:settings.notifications.telegramWizard.botTokenHelp')}{' '}
              <a
                href={TELEGRAM_BOT_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t('pages:settings.notifications.telegramWizard.botTokenHelpLink')}
              </a>
            </FieldDescription>
            {tokenError && <FieldError>{tokenError}</FieldError>}
          </Field>
          <Button onClick={() => void handleStart()} disabled={starting || !botToken.trim()}>
            {starting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('pages:settings.notifications.telegramWizard.validatingButton')}
              </>
            ) : (
              t('pages:settings.notifications.telegramWizard.continueButton')
            )}
          </Button>
        </div>
      )}

      {step === 'pair' && pairing && (
        <div className="flex flex-col gap-4">
          {expired ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p className="font-medium">
                  {t('pages:settings.notifications.telegramWizard.expiredTitle')}
                </p>
                <p>{t('pages:settings.notifications.telegramWizard.expiredDesc')}</p>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm">
                {t('pages:settings.notifications.telegramWizard.step2Instructions')}
              </p>
              <div className="space-y-2">
                <FieldLabel htmlFor="telegram-pairing-code">
                  {t('pages:settings.notifications.telegramWizard.codeLabel')}
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="telegram-pairing-code"
                    readOnly
                    value={pairing.code}
                    className="font-mono text-lg tracking-widest"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void handleCopyCode()}
                    title={t('common:actions.copy')}
                  >
                    {copied ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              <Button asChild variant="outline">
                <a href={pairing.botLink} target="_blank" rel="noopener noreferrer">
                  {t('pages:settings.notifications.telegramWizard.openBotButton', {
                    botUsername: pairing.botUsername,
                  })}
                </a>
              </Button>
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {t('pages:settings.notifications.telegramWizard.waitingForMessage')}
                </span>
                {timeLeft !== null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {t('pages:settings.notifications.telegramWizard.expiresIn', {
                      time: formatTimeLeft(timeLeft),
                    })}
                  </span>
                )}
              </div>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={handleStartOver} className="self-start">
            {t('pages:settings.notifications.telegramWizard.startOver')}
          </Button>
        </div>
      )}

      {step === 'finishing' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          {saveError ? (
            <>
              <Alert variant="destructive" className="text-left">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
              <div className="flex gap-2">
                <Button onClick={() => chatId && void runSave(chatId)} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('common:actions.retry')
                  )}
                </Button>
                <Button variant="outline" onClick={handleStartOver}>
                  {t('pages:settings.notifications.telegramWizard.startOver')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-8 w-8 text-green-600" aria-hidden="true" />
              <p className="font-medium">
                {t('pages:settings.notifications.telegramWizard.step3Title')}
              </p>
              <p className="text-muted-foreground text-sm">
                {t('pages:settings.notifications.telegramWizard.step3Desc')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
