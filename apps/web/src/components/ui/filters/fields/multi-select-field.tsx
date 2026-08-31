import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

const NO_OPTIONS: MultiSelectOption[] = [];
const NO_SELECTION: string[] = [];

export interface MultiSelectFieldProps {
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  options: MultiSelectOption[] | undefined;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  clearLabel: string;
  countLabel: (count: number) => string;
  description?: string;
  id?: string;
  className?: string;
  'aria-labelledby'?: string;
}

export function MultiSelectField({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  clearLabel,
  countLabel,
  description,
  id,
  className,
  'aria-labelledby': ariaLabelledBy,
}: MultiSelectFieldProps) {
  return (
    <>
      <MultiSelect
        id={id}
        options={options ?? NO_OPTIONS}
        value={value ?? NO_SELECTION}
        onChange={(next) => onChange(next.length > 0 ? next : undefined)}
        placeholder={placeholder}
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        clearLabel={clearLabel}
        countLabel={countLabel}
        className={className}
        aria-labelledby={ariaLabelledBy}
      />
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </>
  );
}
