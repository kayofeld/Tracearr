import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ImportPasteStep, type ImportPreview } from './ImportPasteStep';
import { ImportReview } from './ImportReview';

const BODY = 'min-h-0 flex-1 overflow-y-auto px-6 py-4';
const FOOTER = 'border-t px-6 py-4';

/** Full screen below sm, and still a Dialog: one tree, one focus story. */
export const MOBILE_FULLSCREEN =
  'max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0';

interface ImportStepsProps {
  /** What the server said about the paste, once it has been checked. */
  checked: ImportPreview | null;
  onChecked: (result: ImportPreview | null) => void;
  /** Back out of the paste step: to the gallery, or out of the dialog. */
  onExit: () => void;
  onDone: () => void;
  backLabel: string;
}

/** Paste, then review: the two views, wherever they are being shown. */
export function ImportSteps({ checked, onChecked, onExit, onDone, backLabel }: ImportStepsProps) {
  if (checked) {
    return (
      <ImportReview
        preview={checked.preview}
        code={checked.code}
        onAdded={onDone}
        onBack={() => onChecked(null)}
        backLabel={backLabel}
        bodyClassName={BODY}
        footerClassName={FOOTER}
      />
    );
  }

  return (
    <ImportPasteStep
      onChecked={onChecked}
      onBack={onExit}
      backLabel={backLabel}
      bodyClassName={BODY}
      footerClassName={FOOTER}
    />
  );
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The list page's Import button: the same two views with nothing behind them. */
export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { t } = useTranslation('pages');
  const [checked, setChecked] = useState<ImportPreview | null>(null);

  // The dialog outlives every import it runs, so a finished review must not be here on the next open.
  const close = () => {
    setChecked(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        showCloseButton
        className={cn(
          'flex h-[min(72vh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl',
          MOBILE_FULLSCREEN
        )}
        onEscapeKeyDown={(event) => {
          // A checked paste is a screen worth reading; Esc steps back to the box first.
          if (!checked) return;
          event.preventDefault();
          setChecked(null);
        }}
      >
        <DialogHeader className="gap-1 px-6 pt-5 pr-12 pb-3 text-left">
          <div className="flex items-center gap-2">
            {checked && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-ml-2 size-7"
                aria-label={t('automations.bind.back')}
                onClick={() => setChecked(null)}
              >
                <ChevronLeft />
              </Button>
            )}
            <DialogTitle>
              {checked ? checked.preview.envelope.name : t('automations.import.title')}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t(checked ? 'automations.import.reviewDescription' : 'automations.import.description')}
          </DialogDescription>
        </DialogHeader>

        <ImportSteps
          checked={checked}
          onChecked={setChecked}
          onExit={close}
          onDone={close}
          backLabel={t('automations.bind.back')}
        />
      </DialogContent>
    </Dialog>
  );
}
