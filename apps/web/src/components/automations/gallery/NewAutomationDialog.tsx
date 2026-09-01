import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ImportSteps, MOBILE_FULLSCREEN } from '@/components/automations/sharing/ImportDialog';
import { useInstantiateTemplate, useTemplates } from '@/hooks/queries/useTemplates';
import { templateDescription, templateName } from '@/lib/automations';
import { cn } from '@/lib/utils';
import type { ImportPreview } from '@/components/automations/sharing/ImportPasteStep';
import { TemplateBindingForm } from './TemplateBindingForm';
import { TemplateGallery } from './TemplateGallery';

/** The reviewed paste is a view of its own; nothing reaches it without a checked code. */
type View = 'gallery' | 'bind' | 'paste' | 'review';

interface NewAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A deep link opens straight into this template's binding form. */
  templateId?: string | null;
  initialView?: 'gallery' | 'paste';
}

/** One button, one dialog: pick a ready-made automation, then fill in what is yours. */
export function NewAutomationDialog({
  open,
  onOpenChange,
  templateId,
  initialView = 'gallery',
}: NewAutomationDialogProps) {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  const [intent, setIntent] = useState<'gallery' | 'bind' | 'paste'>(
    templateId ? 'bind' : initialView
  );
  const [picked, setPicked] = useState<string | null>(templateId ?? null);
  const [checked, setChecked] = useState<ImportPreview | null>(null);

  const { data: templates, isLoading, isError, refetch } = useTemplates();
  const instantiate = useInstantiateTemplate();
  const selected =
    picked === null ? undefined : templates?.find((template) => template.id === picked);
  // A deep link that names nothing this server has falls back rather than hanging on a blank form.
  const missing = intent === 'bind' && picked !== null && templates !== undefined && !selected;
  // The gallery covers the wait, so the binding form only ever renders a template it has.
  const view: View =
    intent === 'bind' && !selected ? 'gallery' : intent === 'paste' && checked ? 'review' : intent;

  const backToGallery = () => {
    setIntent('gallery');
    setPicked(null);
    setChecked(null);
  };

  /** One step back: the review returns to the box it was pasted in, everything else to the gallery. */
  const goBack = () => {
    if (view === 'review') setChecked(null);
    else backToGallery();
  };

  useEffect(() => {
    if (!missing) return;
    toast.error(t('automations.gallery.missing'));
    setIntent('gallery');
    setPicked(null);
  }, [missing, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className={cn(
          'flex h-[min(72vh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl',
          MOBILE_FULLSCREEN
        )}
        onEscapeKeyDown={(event) => {
          // A stray Esc must not throw away a half-filled form; it goes back first.
          if (view === 'gallery') return;
          event.preventDefault();
          goBack();
        }}
        onKeyDown={(event) => {
          if (event.key !== '/' || view !== 'gallery') return;
          if (event.target === searchRef.current) return;
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogHeader className="gap-1 px-6 pt-5 pr-12 pb-3 text-left">
          {view === 'gallery' ? (
            <>
              <DialogTitle>{t('automations.gallery.title')}</DialogTitle>
              <DialogDescription>{t('automations.gallery.description')}</DialogDescription>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 size-7"
                  aria-label={t('automations.bind.back')}
                  onClick={goBack}
                >
                  <ChevronLeft />
                </Button>
                <DialogTitle>
                  {view === 'review'
                    ? checked?.preview.envelope.name
                    : view === 'paste'
                      ? t('automations.import.title')
                      : selected && templateName(t, selected)}
                </DialogTitle>
                {selected?.builtin && (
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    <span aria-hidden className="opacity-50">
                      ·
                    </span>
                    <ShieldCheck className="size-3" />
                    {t('automations.gallery.builtin')}
                  </span>
                )}
              </div>
              <DialogDescription className="sr-only">
                {view === 'review'
                  ? t('automations.import.reviewDescription')
                  : view === 'paste'
                    ? t('automations.import.description')
                    : selected && templateDescription(t, selected)}
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {view === 'gallery' && (
          <TemplateGallery
            templates={templates ?? []}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => void refetch()}
            searchRef={searchRef}
            onPick={(id) => {
              setPicked(id);
              setIntent('bind');
            }}
            onPaste={() => {
              setPicked(null);
              setIntent('paste');
            }}
            onScratch={() => void navigate('/automations/new')}
          />
        )}

        {view === 'bind' && selected && (
          <TemplateBindingForm
            template={selected}
            bodyClassName="min-h-0 flex-1 overflow-y-auto px-6 py-4"
            footerClassName="border-t px-6 py-4"
            doors={{
              primaryLabel: instantiate.isPending
                ? t('automations.bind.submitting')
                : t('automations.bind.submit'),
              pending: instantiate.isPending,
              onPrimary: (submission) => {
                instantiate.mutate(
                  { id: selected.id, ...submission },
                  { onSuccess: () => onOpenChange(false) }
                );
              },
              secondaryLabel: t('automations.bind.customize'),
              onSecondary: (draft) => {
                onOpenChange(false);
                void navigate('/automations/new', { state: { draft } });
              },
              helper: t('automations.bind.doors.helper'),
            }}
          />
        )}

        {(view === 'paste' || view === 'review') && (
          <ImportSteps
            checked={checked}
            onChecked={setChecked}
            onExit={backToGallery}
            onDone={() => onOpenChange(false)}
            backLabel={t('automations.bind.back')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
