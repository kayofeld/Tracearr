import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAutomationEvaluations } from '@/hooks/queries/useRuns';

/**
 * The capped near-miss ring, folded under the run table: trigger matched, nothing
 * recorded. An empty ring renders nothing, because there is nothing to report.
 */
export function EvaluationsList({ automationId }: { automationId: string }) {
  const { t } = useTranslation('pages');
  const { data } = useAutomationEvaluations(automationId);
  const entries = data?.data ?? [];

  if (entries.length === 0) return null;

  return (
    <Collapsible className="group/near">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2">
          <ChevronRight className="transition-transform group-data-[state=open]/near:rotate-90" />
          {t('automations.evaluations.disclosure', { total: entries.length })}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="text-muted-foreground divide-y text-sm">
          {entries.map((entry) => (
            <li
              key={`${entry.at}-${entry.subjectKey}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span>{t(`automations.evaluations.reasons.${entry.reason}`)}</span>
              <span className="whitespace-nowrap">
                {formatDistanceToNow(new Date(entry.at), { addSuffix: true })}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
