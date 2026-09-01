import { useTranslation } from 'react-i18next';
import type { AutomationKind } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';

const KIND_VARIANT: Record<AutomationKind, 'default' | 'outline'> = {
  policy: 'default',
  notification: 'outline',
};

/** Which kind of row this is, worded and weighted the same on the list and the page. */
export function AutomationKindBadge({ kind }: { kind: AutomationKind }) {
  const { t } = useTranslation('pages');

  return <Badge variant={KIND_VARIANT[kind]}>{t(`automations.kind.${kind}`)}</Badge>;
}
