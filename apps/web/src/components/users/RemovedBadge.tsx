import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface RemovedBadgeProps {
  removedAt: string | Date;
  className?: string;
}

/**
 * Status pill for an account removed from a server, following the same
 * Badge convention as SeverityBadge rather than a hand-rolled span.
 */
export function RemovedBadge({ removedAt, className }: RemovedBadgeProps) {
  const { t } = useTranslation(['pages']);
  const removedDate = typeof removedAt === 'string' ? new Date(removedAt) : removedAt;
  const label = t('pages:users.mergeServerAccountRemoved');

  return (
    <Badge
      variant="danger"
      className={cn('gap-1 font-normal', className)}
      title={`${label} ${formatDistanceToNow(removedDate, { addSuffix: true })}`}
    >
      <UserX className="h-3 w-3" />
      {label}
    </Badge>
  );
}
