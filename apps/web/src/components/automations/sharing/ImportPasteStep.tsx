import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShareCodeReason } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { usePreviewTemplate } from '@/hooks/queries/useTemplates';
import { cn } from '@/lib/utils';
import { GALLERY_URL, LinkOut } from './links';
import { ApiError, type TemplateImportBody, type TemplatePreview } from '@/lib/api';

/** The most the server will decode, so a runaway paste never becomes a request. */
const MAX_PASTE = 65536;

type ImportError = 'notACode' | 'tooBig' | 'truncated' | 'tooNew' | 'tooMany' | 'rejected';

/** What the reader is told for each way the server can refuse a code. */
const DECODE_ERRORS: Record<string, ImportError> = {
  prefix: 'notACode',
  too_long: 'tooBig',
  incomplete: 'truncated',
  too_deep: 'rejected',
  invalid_json: 'rejected',
} satisfies Record<ShareCodeReason, ImportError>;

/** What a pasted code turns out to be; the envelope path never decodes anything. */
function readPaste(text: string): { body: TemplateImportBody; code: string | null } | ImportError {
  if (text.length > MAX_PASTE) return 'tooBig';
  if (!text.startsWith('{')) return { body: { code: text }, code: text };
  try {
    return { body: { envelope: JSON.parse(text) as unknown }, code: null };
  } catch {
    return 'notACode';
  }
}

function errorOf(error: unknown): ImportError {
  if (error instanceof ApiError && error.status === 429) return 'tooMany';
  const reason = error instanceof ApiError ? error.body.reason : undefined;
  return (typeof reason === 'string' ? DECODE_ERRORS[reason] : undefined) ?? 'rejected';
}

export interface ImportPreview {
  preview: TemplatePreview;
  /** The share code as pasted, or null when the reader pasted JSON instead. */
  code: string | null;
}

interface ImportPasteStepProps {
  onChecked: (result: ImportPreview) => void;
  onBack: () => void;
  backLabel: string;
  bodyClassName?: string;
  footerClassName?: string;
}

/** The textarea, and the one button that asks the server what it is. */
export function ImportPasteStep({
  onChecked,
  onBack,
  backLabel,
  bodyClassName,
  footerClassName,
}: ImportPasteStepProps) {
  const { t } = useTranslation('pages');
  const check = usePreviewTemplate();

  const [text, setText] = useState('');
  const [problem, setProblem] = useState<{
    kind: ImportError;
    versions?: { required: string; current: string };
  } | null>(null);

  const submit = () => {
    const pasted = text.trim();
    const read = readPaste(pasted);
    if (typeof read === 'string') {
      setProblem({ kind: read });
      return;
    }

    setProblem(null);
    check.mutate(read.body, {
      onSuccess: (preview) => {
        if (!preview.minServerVersion.satisfied) {
          setProblem({ kind: 'tooNew', versions: preview.minServerVersion });
          return;
        }
        onChecked({ preview, code: read.code });
      },
      onError: (error) => setProblem({ kind: errorOf(error) }),
    });
  };

  return (
    <>
      <div className={cn('flex flex-col gap-4', bodyClassName)}>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t('automations.import.description')}
        </p>
        <Field>
          <FieldLabel htmlFor="share-code" className="sr-only">
            {t('automations.import.title')}
          </FieldLabel>
          <Textarea
            id="share-code"
            rows={5}
            spellCheck={false}
            className="font-mono text-xs break-all"
            placeholder={t('automations.import.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>{t('automations.import.formatHint')}</FieldDescription>
          {problem && (
            <FieldError>
              <p>{t(`automations.import.errors.${problem.kind}`, problem.versions)}</p>
              <p className="text-muted-foreground mt-1 leading-relaxed">
                {t(`automations.import.errors.${problem.kind}Hint`, problem.versions)}
              </p>
            </FieldError>
          )}
        </Field>

        <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
          {t('automations.import.source')}
          <LinkOut href={GALLERY_URL} label={t('automations.openGallery')} />
        </div>
      </div>

      <div className={cn('flex justify-end gap-2', footerClassName)}>
        <Button type="button" variant="outline" onClick={onBack}>
          {backLabel}
        </Button>
        <Button type="button" onClick={submit} disabled={text.trim() === '' || check.isPending}>
          {check.isPending ? t('automations.import.checking') : t('automations.import.check')}
        </Button>
      </div>
    </>
  );
}
