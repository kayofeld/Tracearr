import { isDateRangeValue } from '../filter-utils';
import type { FilterDescriptor, FilterValue } from '../types';
import { BooleanField } from './boolean-field';
import { DateRangeField } from './date-range-field';
import { MultiSelectField } from './multi-select-field';
import { SearchField } from './search-field';
import { SelectField } from './select-field';

export interface FilterFieldProps {
  descriptor: FilterDescriptor;
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  id: string;
  className?: string;
  'aria-labelledby'?: string;
}

export function FilterField({
  descriptor,
  value,
  onChange,
  id,
  className,
  'aria-labelledby': ariaLabelledBy,
}: FilterFieldProps) {
  switch (descriptor.kind) {
    case 'search':
      return (
        <SearchField
          id={id}
          value={typeof value === 'string' ? value : undefined}
          onChange={onChange}
          placeholder={descriptor.placeholder}
          clearLabel={descriptor.clearLabel}
          debounceMs={descriptor.debounceMs}
          className={className}
          aria-label={ariaLabelledBy ? undefined : descriptor.label}
          aria-labelledby={ariaLabelledBy}
        />
      );

    case 'multiSelect':
      return (
        <MultiSelectField
          id={id}
          value={Array.isArray(value) ? value : undefined}
          onChange={onChange}
          options={descriptor.options}
          placeholder={descriptor.placeholder}
          searchPlaceholder={descriptor.searchPlaceholder}
          emptyMessage={descriptor.emptyMessage}
          clearLabel={descriptor.clearLabel}
          countLabel={descriptor.countLabel}
          description={descriptor.description}
          className={className}
          aria-labelledby={ariaLabelledBy}
        />
      );

    case 'select':
      return (
        <SelectField
          id={id}
          value={typeof value === 'string' ? value : undefined}
          onChange={onChange}
          options={descriptor.options}
          allLabel={descriptor.allLabel}
          className={className}
          aria-label={ariaLabelledBy ? undefined : descriptor.label}
          aria-labelledby={ariaLabelledBy}
        />
      );

    case 'dateRange':
      return (
        <DateRangeField
          id={id}
          value={isDateRangeValue(value) ? value : undefined}
          onChange={onChange}
          labels={descriptor.labels}
          formatValue={descriptor.formatValue}
          formatDate={descriptor.formatDate}
          minDate={descriptor.minDate}
          maxDate={descriptor.maxDate}
          numberOfMonths={descriptor.numberOfMonths}
          className={className}
          aria-labelledby={ariaLabelledBy}
        />
      );

    case 'boolean':
      return (
        <BooleanField
          id={id}
          value={value === true}
          onChange={onChange}
          label={descriptor.description ?? descriptor.label}
          className={className}
        />
      );
  }
}
