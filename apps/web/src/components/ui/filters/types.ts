import type { ReactNode } from 'react';
import type { MultiSelectOption } from '@/components/ui/multi-select';

/**
 * Both ends are independent and either may be set alone, which is what
 * TimeRangeValue cannot express. ISO calendar dates (YYYY-MM-DD) rather than
 * Date objects, so the same state serialises into the URL, localStorage and a
 * React Query key without conversion.
 */
export interface DateRangeValue {
  from?: string;
  to?: string;
}

export type FilterValue = string | string[] | boolean | DateRangeValue | undefined;

/**
 * One key per filter, flat and JSON-serialisable. `undefined` means not set:
 * never null, never an empty array, so "is this filter active?" is a single
 * `!== undefined` check.
 */
export type FilterState = Record<string, FilterValue>;

export interface FilterSelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface DateRangeFieldLabels {
  placeholder: string;
  apply: string;
  cancel: string;
  /** Accessible name for the trigger's inline clear control. */
  clear: string;
  clearStart: string;
  clearEnd: string;
}

interface FilterDescriptorBase {
  key: string;
  label: string;
  /** Renders in the bar itself instead of inside the filter panel. */
  inline?: boolean;
  /** Layout classes for the field's wrapper in the bar, e.g. an inline
   *  search box's width. */
  className?: string;
}

export interface SearchFilterDescriptor extends FilterDescriptorBase {
  kind: 'search';
  placeholder: string;
  clearLabel: string;
  debounceMs?: number;
}

export interface MultiSelectFilterDescriptor extends FilterDescriptorBase {
  kind: 'multiSelect';
  /** `undefined` means the options have not loaded; validation leaves a
   *  persisted value alone rather than false-dropping it. */
  options: MultiSelectOption[] | undefined;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  clearLabel: string;
  countLabel: (count: number) => string;
  /** Hint rendered under the control, e.g. to explain AND semantics. */
  description?: string;
}

export interface SelectFilterDescriptor extends FilterDescriptorBase {
  kind: 'select';
  /** `undefined` means the options have not loaded. */
  options: FilterSelectOption[] | undefined;
  /** Label of the "no filter" entry. */
  allLabel: string;
}

export interface DateRangeFilterDescriptor extends FilterDescriptorBase {
  kind: 'dateRange';
  labels: DateRangeFieldLabels;
  /** Trigger summary and chip text. Owns its own formatting so nothing in
   *  `ui/` has to call `t()`. */
  formatValue: (value: DateRangeValue) => string;
  formatDate?: (isoDate: string) => string;
  minDate?: Date;
  maxDate?: Date;
  numberOfMonths?: number;
}

export interface BooleanFilterDescriptor extends FilterDescriptorBase {
  kind: 'boolean';
  /** Sits next to the switch; falls back to `label`. */
  description?: string;
}

export type FilterDescriptor =
  | SearchFilterDescriptor
  | MultiSelectFilterDescriptor
  | SelectFilterDescriptor
  | DateRangeFilterDescriptor
  | BooleanFilterDescriptor;

export interface ActiveFilterChip {
  key: string;
  label: string;
  value: string;
}
