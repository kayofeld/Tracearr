import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AutomationBuilder } from '@/components/automations/builder';
import { Skeleton } from '@/components/ui/skeleton';
import { useAutomation } from '@/hooks/queries/useAutomations';
import type { AutomationDraft } from '@/lib/automations';

export function AutomationBuilderPage() {
  const { t } = useTranslation('pages');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: automation, isLoading } = useAutomation(id);

  // The answers ride along in router state; an edit route always wins over them.
  const carried = location.state as { draft?: AutomationDraft } | null;
  const draft = id === undefined ? carried?.draft : undefined;

  // A bound row's steps belong to its template; the builder would offer edits the API refuses.
  const bound = automation?.template != null;
  useEffect(() => {
    if (!bound || !automation) return;
    toast.info(t('automations.template.customizeFirst'));
    void navigate(`/automations/${automation.id}`, { replace: true });
  }, [bound, automation, navigate, t]);

  if (isLoading || bound) {
    return <Skeleton className="mx-auto h-96 w-full max-w-4xl" />;
  }

  return <AutomationBuilder automation={automation} draft={draft} />;
}
