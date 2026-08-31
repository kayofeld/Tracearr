import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareQuote } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SentencePanelProps {
  children: ReactNode;
  className?: string;
}

/** The framed block the automation's own sentence sits in, wherever it is shown. */
export function SentencePanel({ children, className }: SentencePanelProps) {
  const { t } = useTranslation('pages');

  return (
    <div
      className={cn('border-l-primary/55 bg-muted/35 rounded-lg border border-l-2 p-4', className)}
    >
      <h2 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
        <MessageSquareQuote className="size-3.5" />
        {t('automations.builder.sentence.label')}
      </h2>
      {children}
    </div>
  );
}
