import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import type { BuilderIssue } from './validation';

interface RowActionsProps {
  /** The row's own name, so the switch and the remove button say what they act on. */
  name: string;
  enabled: boolean;
  onToggle: () => void;
  onRemove: () => void;
  /** An overflow menu, sitting between the switch and the remove button. */
  children?: ReactNode;
}

/** What every node row carries on its right: whether it runs, and how to drop it. */
export function RowActions({ name, enabled, onToggle, onRemove, children }: RowActionsProps) {
  const { t } = useTranslation('pages');

  return (
    <>
      {!enabled && <Badge variant="secondary">{t('automations.builder.rows.skipped')}</Badge>}
      <Switch
        checked={enabled}
        aria-label={t('automations.builder.rows.toggle', { name })}
        onCheckedChange={onToggle}
      />
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('automations.builder.rows.remove', { name })}
        onClick={onRemove}
      >
        <X />
      </Button>
    </>
  );
}

/** A row that will not do what it looks like it does, said in plain words. */
export function RowWarning({ message }: { message: string }) {
  // The amber is the icon and the row's border; the words stay at reading contrast.
  return (
    <p className="text-foreground mt-1.5 flex items-start gap-1.5 text-xs">
      <TriangleAlert className="text-warning mt-0.5 size-3 shrink-0" />
      {message}
    </p>
  );
}

/**
 * A row's problems. What the rest of the definition did to this row is amber; what
 * this row's own fields got wrong stays an error.
 */
export function RowIssues({ issues }: { issues: readonly BuilderIssue[] | undefined }) {
  return (
    <>
      {issues?.map((issue) =>
        issue.tone === 'warning' ? (
          <RowWarning key={issue.message} message={issue.message} />
        ) : (
          <FieldError key={issue.message}>{issue.message}</FieldError>
        )
      )}
    </>
  );
}
