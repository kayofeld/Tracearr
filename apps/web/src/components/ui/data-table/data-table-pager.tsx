import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { DataTablePagerState } from './use-data-table';

export interface DataTablePagerLabels {
  /** aria-label for the surrounding nav, e.g. "Pagination". */
  navigation: string;
  /** Already-interpolated status text, e.g. "Page 2 of 7". */
  status: string;
  previous: string;
  next: string;
}

interface DataTablePagerProps extends DataTablePagerState {
  labels: DataTablePagerLabels;
  className?: string;
}

export function DataTablePager({
  pageCount,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  labels,
  className,
}: DataTablePagerProps) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label={labels.navigation}
      className={cn('flex items-center justify-between', className)}
    >
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {labels.status}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={!canPrevious}>
          <ChevronLeft />
          {labels.previous}
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!canNext}>
          {labels.next}
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
