import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TemplateEffects } from '@/components/automations/gallery/TemplateEffects';
import {
  TemplateInputRows,
  TemplateSentencePanel,
  useTemplateAnswers,
} from '@/components/automations/gallery/TemplateInputs';
import { useImportTemplate, useInstantiateTemplate } from '@/hooks/queries/useTemplates';
import { cn } from '@/lib/utils';
import { Disclosure } from './Disclosure';
import type { AutomationTemplate, TemplateImportBody, TemplatePreview } from '@/lib/api';

/** Enough of the fingerprint to compare two codes by eye, and no more. */
const shortCode = (fingerprint: string) => `${fingerprint.slice(0, 4)}…${fingerprint.slice(-3)}`;

interface ImportReviewProps {
  preview: TemplatePreview;
  /** The share code as pasted, or null when the reader pasted JSON. */
  code: string | null;
  onAdded: () => void;
  onBack: () => void;
  backLabel: string;
  bodyClassName?: string;
  footerClassName?: string;
}

/** What it is, what it says, what it will do, then what it needs and how it starts. */
export function ImportReview({
  preview,
  code,
  onAdded,
  onBack,
  backLabel,
  bodyClassName,
  footerClassName,
}: ImportReviewProps) {
  const { t } = useTranslation('pages');
  const { envelope, existing } = preview;

  const answers = useTemplateAnswers(envelope);
  const [paused, setPaused] = useState(true);
  const [replaceMine, setReplaceMine] = useState(false);

  const store = useImportTemplate();
  const instantiate = useInstantiateTemplate();
  const pending = store.isPending || instantiate.isPending;

  const known = existing?.fingerprintMatch === true ? existing : undefined;
  const collision = existing && !existing.fingerprintMatch ? existing : undefined;
  // The one claim the app can make itself: these steps are the ones Tracearr ships.
  const shipped = known?.builtin === true ? known : undefined;

  const create = (): TemplateImportBody => ({
    ...(code === null ? { envelope } : { code }),
    ...(collision && replaceMine ? { replace: collision.templateId } : {}),
  });

  const bind = (templateId: string) => {
    instantiate.mutate(
      { id: templateId, inputs: answers.bound(), isActive: !paused },
      { onSuccess: onAdded }
    );
  };

  const submit = () => {
    if (!answers.attemptSubmit()) return;
    // A code the library already holds writes nothing; only the automation is new.
    if (known) return bind(known.templateId);
    store.mutate(create(), {
      onSuccess: (template: AutomationTemplate) => bind(template.id),
      onError: (error: Error) =>
        toast.error(t('automations.bind.failed'), { description: error.message }),
    });
  };

  return (
    <>
      <div className={cn('flex flex-col gap-5', bodyClassName)}>
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2
              aria-hidden
              className={cn('size-4 shrink-0', shipped ? 'text-success' : 'text-muted-foreground')}
            />
            {shipped
              ? t('automations.import.builtinMatch', { name: shipped.name })
              : t('automations.import.valid')}
          </p>
          {!shipped && (
            <p className="text-muted-foreground pl-6 text-xs">
              {t('automations.import.validCaveat')}
            </p>
          )}
          <p className="text-muted-foreground pl-6 text-xs">
            {[
              envelope.author === undefined
                ? undefined
                : t('automations.import.madeBy', { author: envelope.author }),
              t('automations.import.codeShort', { fingerprint: shortCode(envelope.fingerprint) }),
            ]
              .filter((part) => part !== undefined)
              .join(' · ')}
          </p>
        </div>

        {known && (
          <p className="text-sm">{t('automations.import.existing', { name: known.name })}</p>
        )}

        {collision && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {t('automations.import.collision.title', { name: collision.name })}
            </p>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={replaceMine ? 'replace' : 'add'}
              aria-label={t('automations.import.collision.title', { name: collision.name })}
              onValueChange={(next) => {
                if (next) setReplaceMine(next === 'replace');
              }}
            >
              <ToggleGroupItem value="add">{t('automations.import.collision.add')}</ToggleGroupItem>
              {!collision.builtin && (
                <ToggleGroupItem value="replace">
                  {t('automations.import.collision.replace')}
                </ToggleGroupItem>
              )}
            </ToggleGroup>
          </div>
        )}

        <TemplateSentencePanel fragments={answers.fragments} highlightKey={answers.focused} />

        <TemplateEffects
          definition={envelope.definition}
          hasServerInput={answers.serverKey !== undefined}
          serverName={answers.refs.servers?.[answers.boundServerId]}
        />

        {envelope.inputs.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('automations.bind.noInputs')}</p>
        ) : (
          <section aria-label={t('automations.bind.needs.title')}>
            <FieldGroup className="gap-5">
              <TemplateInputRows
                version={envelope}
                values={answers.values}
                onChange={answers.setValue}
                boundServerId={answers.boundServerId}
                submitted={answers.submitted}
                onFocusInput={answers.setFocused}
              />
            </FieldGroup>
          </section>
        )}

        <Disclosure label={t('automations.import.raw')}>
          <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 text-xs">
            {JSON.stringify(envelope, null, 2)}
          </pre>
        </Disclosure>
      </div>

      <div className={cn('flex flex-col gap-2.5', footerClassName)}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3">
          <div className="flex items-center gap-2">
            <Switch id="import-paused" checked={paused} onCheckedChange={setPaused} />
            <FieldLabel htmlFor="import-paused">{t('automations.import.paused.label')}</FieldLabel>
          </div>
          <div className="flex gap-2 max-sm:w-full max-sm:flex-col-reverse sm:ml-auto">
            <Button type="button" variant="outline" onClick={onBack} disabled={pending}>
              {backLabel}
            </Button>
            <Button type="button" onClick={submit} disabled={pending}>
              {pending
                ? t('automations.import.adding')
                : known
                  ? t('automations.import.existingUse')
                  : t('automations.import.submit')}
            </Button>
          </div>
        </div>
        {paused && <FieldDescription>{t('automations.import.paused.helper')}</FieldDescription>}
      </div>
    </>
  );
}
