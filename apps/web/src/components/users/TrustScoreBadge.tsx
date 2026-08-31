import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TrustScoreBadgeProps {
  score: number;
  showLabel?: boolean;
  className?: string;
}

interface TrustLevel {
  variant: 'success' | 'warning' | 'danger';
  labelKey: 'trust.trusted' | 'trust.caution' | 'trust.untrusted';
}

function getTrustLevel(score: number): TrustLevel {
  if (score >= 80) {
    return { variant: 'success', labelKey: 'trust.trusted' };
  }
  if (score >= 50) {
    return { variant: 'warning', labelKey: 'trust.caution' };
  }
  return { variant: 'danger', labelKey: 'trust.untrusted' };
}

export function TrustScoreBadge({ score, showLabel = false, className }: TrustScoreBadgeProps) {
  const { t } = useTranslation('common');
  const { variant, labelKey } = getTrustLevel(score);

  return (
    <Badge variant={variant} className={cn('gap-1', className)}>
      <span className="font-mono">{score}</span>
      {showLabel && <span>· {t(labelKey)}</span>}
    </Badge>
  );
}
