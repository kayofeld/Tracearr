import { useTranslation } from 'react-i18next';
import type { ConditionMatch } from '@tracearr/shared';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';

interface ConnectiveSelectProps {
  match: ConditionMatch;
  onChange: (match: ConditionMatch) => void;
}

/** The word between two checks, which is also the control that sets how they combine. */
export function ConnectiveSelect({ match, onChange }: ConnectiveSelectProps) {
  const { t } = useTranslation('pages');

  return (
    <div className="relative flex h-7 items-center">
      <div className="bg-border absolute inset-x-0 top-1/2 h-px" />
      <Select
        value={match}
        onValueChange={(next) => {
          if (next === 'all' || next === 'any') onChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={t('automations.builder.conditions.matchLabel')}
          className="bg-card-raised relative mr-2 h-6 gap-1 px-2 py-0 text-xs font-medium"
        >
          {t(`automations.builder.conditions.${match}`)}
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="all">{t('automations.builder.conditions.allHint')}</SelectItem>
          <SelectItem value="any">{t('automations.builder.conditions.anyHint')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
