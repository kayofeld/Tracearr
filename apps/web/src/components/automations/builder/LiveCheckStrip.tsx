import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Radio, X } from 'lucide-react';
import { TRIGGERS, type CreateAutomationInput, type DryRunSample } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { useDryRun } from '@/hooks/queries/useDryRun';
import { conditionText, valueText, type Translate } from '@/lib/automations';
import { cn } from '@/lib/utils';

interface LiveCheckStripProps {
  definition: CreateAutomationInput;
  /** False while the page has problems of its own; the draft would be rejected as it stands. */
  ready: boolean;
  /** A save is in flight, so nothing is asked until it lands. */
  paused: boolean;
}

/** Why there is nothing to read yet, or nothing to read at all. */
function statusOf(
  t: Translate,
  state: {
    active: boolean;
    ready: boolean;
    replaying: boolean;
    check: { isPending: boolean; isError: boolean };
    samples: readonly unknown[];
  }
): string | null {
  if (!state.active) {
    return state.ready
      ? t('automations.builder.liveCheck.paused')
      : t('automations.builder.liveCheck.unfinished');
  }
  if (state.check.isPending) return t('automations.builder.liveCheck.checking');
  if (state.check.isError) {
    return state.replaying
      ? t('automations.builder.liveCheck.sampleGone')
      : t('automations.builder.liveCheck.failed');
  }
  if (state.samples.length > 0) return null;
  return state.replaying
    ? t('automations.builder.liveCheck.sampleGone')
    : t('automations.builder.liveCheck.empty');
}

/**
 * What the draft would do to the sessions playing right now. The page fetches no
 * sessions of its own: the answer names the ones it was checked against.
 */
export function LiveCheckStrip({ definition, ready, paused }: LiveCheckStripProps) {
  const { t } = useTranslation('pages');
  const [searchParams, setSearchParams] = useSearchParams();

  // A run opened in the editor names the session it ran against; without one the
  // check reads whatever is playing.
  const sampleSessionId = searchParams.get('sample') ?? undefined;

  const reachesSessions = definition.triggers.some(
    (trigger) => trigger.enabled && TRIGGERS[trigger.type].context === 'session'
  );
  const active = ready && !paused;
  const check = useDryRun(definition, { enabled: active && reachesSessions, sampleSessionId });

  if (!reachesSessions) return null;

  const samples = active ? (check.data?.samples ?? []) : [];
  const replaying = sampleSessionId !== undefined;
  const status = statusOf(t, { active, ready, replaying, check, samples });

  return (
    <div className="mt-4 space-y-2">
      <Separator className="mb-4" />
      <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs font-medium">
        <Radio className="size-3.5" />
        {replaying
          ? t('automations.builder.liveCheck.sampleTitle')
          : t('automations.builder.liveCheck.title')}
        {replaying && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() =>
              setSearchParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  next.delete('sample');
                  return next;
                },
                { replace: true }
              )
            }
          >
            {t('automations.builder.liveCheck.backToLive')}
          </Button>
        )}
      </p>

      {/* Only the verdict speaks; the heading and the footnote do not change. */}
      <div className="space-y-2" aria-live="polite">
        {status !== null && <p className="text-muted-foreground text-sm">{status}</p>}

        {samples.map((sample) => (
          <SampleRow key={sample.subject.sessionId} sample={sample} />
        ))}
      </div>

      <p className="text-muted-foreground text-xs">{t('automations.builder.liveCheck.footnote')}</p>
    </div>
  );
}

/** One session, its verdict in words, and the conditions behind it when opened. */
function SampleRow({ sample }: { sample: DryRunSample }) {
  const { t } = useTranslation('pages');

  return (
    <Collapsible>
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            sample.wouldRun ? 'bg-success' : 'bg-muted-foreground/50'
          )}
        />
        <p className="flex-1 text-sm">{sample.summary}</p>
        {sample.conditions.length > 0 && (
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t('automations.builder.liveCheck.expand', {
                name: sample.subject.user.name,
              })}
            >
              <ChevronDown />
            </Button>
          </CollapsibleTrigger>
        )}
      </div>

      <CollapsibleContent>
        <ul className="mt-1 ml-4 space-y-1">
          {sample.conditions.map((condition) => (
            <li key={condition.nodeId} className="flex flex-wrap items-center gap-1.5 text-xs">
              {condition.passed ? (
                <Check className="text-success size-3.5 shrink-0" />
              ) : (
                <X className="text-destructive size-3.5 shrink-0" />
              )}
              <span className="sr-only">
                {condition.passed
                  ? t('automations.builder.liveCheck.passed')
                  : t('automations.builder.liveCheck.notPassed')}
              </span>
              <span>{conditionText(t, condition.evidence)}</span>
              <span className="text-muted-foreground">
                {t('automations.builder.liveCheck.actual', {
                  value: valueText(t, condition.evidence.actual),
                })}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
