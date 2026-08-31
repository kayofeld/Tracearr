import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FilterSelectOption } from '../types';

/** Radix Select has no empty-string value, so "no filter" needs a sentinel. */
const ALL_SENTINEL = '__all__';

export interface SelectFieldProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: FilterSelectOption[] | undefined;
  allLabel: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function SelectField({
  value,
  onChange,
  options,
  allLabel,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SelectFieldProps) {
  return (
    <Select
      value={value ?? ALL_SENTINEL}
      onValueChange={(next) => onChange(next === ALL_SENTINEL ? undefined : next)}
    >
      <SelectTrigger
        id={id}
        className={className}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_SENTINEL}>{allLabel}</SelectItem>
        {options?.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
