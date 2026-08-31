import { useEffect, useState } from 'react';
import { CalendarIcon, X } from 'lucide-react';
import type { DateRange, Matcher } from 'react-day-picker';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerClasses } from '@/components/ui/select';
import { fromIsoDate, toIsoDate } from '../filter-utils';
import type { DateRangeFieldLabels, DateRangeValue } from '../types';

export interface DateRangeFieldProps {
  value: DateRangeValue | undefined;
  onChange: (value: DateRangeValue | undefined) => void;
  labels: DateRangeFieldLabels;
  /** Trigger summary text; the caller owns its wording and locale. */
  formatValue: (value: DateRangeValue) => string;
  formatDate?: (isoDate: string) => string;
  minDate?: Date;
  maxDate?: Date;
  numberOfMonths?: number;
  id?: string;
  className?: string;
  'aria-labelledby'?: string;
}

function toDateRange(value: DateRangeValue | undefined): DateRange | undefined {
  const from = fromIsoDate(value?.from);
  const to = fromIsoDate(value?.to);
  return from === undefined && to === undefined ? undefined : { from, to };
}

export function DateRangeField({
  value,
  onChange,
  labels,
  formatValue,
  formatDate = (isoDate) => isoDate,
  minDate,
  maxDate,
  numberOfMonths = 1,
  id,
  className,
  'aria-labelledby': ariaLabelledBy,
}: DateRangeFieldProps) {
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<DateRange | undefined>(() => toDateRange(value));

  const from = value?.from;
  const to = value?.to;

  useEffect(() => {
    if (open) setStaged(toDateRange({ from, to }));
  }, [open, from, to]);

  const disabled: Matcher[] = [];
  if (minDate) disabled.push({ before: minDate });
  if (maxDate) disabled.push({ after: maxDate });

  const isSet = from !== undefined || to !== undefined;
  const summary = isSet ? formatValue({ from, to }) : labels.placeholder;

  const apply = () => {
    const next: DateRangeValue = {};
    if (staged?.from) next.from = toIsoDate(staged.from);
    if (staged?.to) next.to = toIsoDate(staged.to);
    onChange(next.from === undefined && next.to === undefined ? undefined : next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-labelledby={ariaLabelledBy}
          className={cn(selectTriggerClasses, 'w-full', className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarIcon className="h-4 w-4 shrink-0 opacity-50" />
            <span className={cn('truncate', !isSet && 'text-muted-foreground')}>{summary}</span>
          </span>
          {isSet && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={labels.clear}
              className="text-muted-foreground hover:text-foreground ml-2 shrink-0 rounded p-0.5"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(undefined);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        {(staged?.from || staged?.to) && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {staged.from && (
              <span className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5">
                {formatDate(toIsoDate(staged.from))}
                <button
                  type="button"
                  aria-label={labels.clearStart}
                  className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                  onClick={() => setStaged({ from: undefined, to: staged.to })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {staged.to && (
              <span className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5">
                {formatDate(toIsoDate(staged.to))}
                <button
                  type="button"
                  aria-label={labels.clearEnd}
                  className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                  onClick={() => setStaged({ from: staged.from, to: undefined })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>
        )}
        <Calendar
          mode="range"
          defaultMonth={staged?.from ?? staged?.to}
          selected={staged}
          onSelect={setStaged}
          numberOfMonths={numberOfMonths}
          disabled={disabled.length > 0 ? disabled : undefined}
        />
        <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {labels.cancel}
          </Button>
          <Button size="sm" onClick={apply}>
            {labels.apply}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
