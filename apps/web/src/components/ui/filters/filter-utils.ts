import { format, isValid, parseISO } from 'date-fns';
import type {
  ActiveFilterChip,
  DateRangeValue,
  FilterDescriptor,
  FilterState,
  FilterValue,
} from './types';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_PATTERN.test(value) && isValid(parseISO(value));
}

/** Local-time formatting: `toISOString` would shift the day west of UTC. */
export function toIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function fromIsoDate(value: string | undefined): Date | undefined {
  return isIsoDate(value) ? parseISO(value) : undefined;
}

export function isDateRangeValue(value: FilterValue): value is DateRangeValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collapses every "empty" spelling to `undefined`, which is the one thing the
 * whole system leans on: an active filter is a key whose value is not
 * `undefined`.
 */
export function normalizeFilterValue(
  kind: FilterDescriptor['kind'],
  raw: FilterValue
): FilterValue {
  switch (kind) {
    case 'search': {
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    case 'select':
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    case 'multiSelect': {
      if (!Array.isArray(raw)) return undefined;
      const entries = raw.filter((entry) => typeof entry === 'string' && entry.length > 0);
      return entries.length > 0 ? entries : undefined;
    }
    case 'boolean':
      return raw === true ? true : undefined;
    case 'dateRange': {
      if (!isDateRangeValue(raw)) return undefined;
      const range: DateRangeValue = {};
      if (isIsoDate(raw.from)) range.from = raw.from;
      if (isIsoDate(raw.to)) range.to = raw.to;
      return range.from === undefined && range.to === undefined ? undefined : range;
    }
  }
}

export function filterValuesEqual(a: FilterValue, b: FilterValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  if (isDateRangeValue(a) && isDateRangeValue(b)) return a.from === b.from && a.to === b.to;
  return false;
}

/** Writing `undefined` deletes the key, so a cleared filter never lingers as
 *  an explicit `undefined` in a serialised payload. */
export function setFilterValue<S extends FilterState>(
  state: S,
  key: string,
  value: FilterValue
): S {
  const { [key]: _removed, ...rest } = state;
  return (value === undefined ? rest : { ...rest, [key]: value }) as S;
}

/**
 * Drops values that no longer resolve: an option removed from the account, a
 * malformed persisted date. A descriptor whose `options` are `undefined` has
 * not loaded its list yet, so its value is left alone rather than false-dropped.
 */
export function validateFilters<S extends FilterState>(
  state: S,
  descriptors: FilterDescriptor[]
): S {
  let next = state;

  for (const descriptor of descriptors) {
    const current = next[descriptor.key];
    let value = normalizeFilterValue(descriptor.kind, current);

    if (descriptor.kind === 'multiSelect' && descriptor.options && Array.isArray(value)) {
      const known = new Set(descriptor.options.map((option) => option.value));
      const kept = value.filter((entry) => known.has(entry));
      value = kept.length > 0 ? kept : undefined;
    }

    if (descriptor.kind === 'select' && descriptor.options && typeof value === 'string') {
      const match = value;
      value = descriptor.options.some((option) => option.value === match) ? match : undefined;
    }

    if (!filterValuesEqual(current, value)) next = setFilterValue(next, descriptor.key, value);
  }

  return next;
}

export function filterParamNames(descriptor: FilterDescriptor): string[] {
  return descriptor.kind === 'dateRange'
    ? [`${descriptor.key}From`, `${descriptor.key}To`]
    : [descriptor.key];
}

export function filtersToSearchParams(
  state: FilterState,
  descriptors: FilterDescriptor[],
  base?: URLSearchParams
): URLSearchParams {
  const params = new URLSearchParams(base);

  for (const descriptor of descriptors) {
    for (const name of filterParamNames(descriptor)) params.delete(name);

    const value = normalizeFilterValue(descriptor.kind, state[descriptor.key]);
    if (value === undefined) continue;

    switch (descriptor.kind) {
      case 'search':
      case 'select':
        if (typeof value === 'string') params.set(descriptor.key, value);
        break;
      case 'multiSelect':
        if (Array.isArray(value)) {
          for (const entry of value) params.append(descriptor.key, entry);
        }
        break;
      case 'boolean':
        params.set(descriptor.key, '1');
        break;
      case 'dateRange':
        if (isDateRangeValue(value)) {
          if (value.from) params.set(`${descriptor.key}From`, value.from);
          if (value.to) params.set(`${descriptor.key}To`, value.to);
        }
        break;
    }
  }

  return params;
}

export function filtersFromSearchParams(
  params: URLSearchParams,
  descriptors: FilterDescriptor[]
): FilterState {
  const raw: FilterState = {};

  for (const descriptor of descriptors) {
    switch (descriptor.kind) {
      case 'search':
      case 'select':
        raw[descriptor.key] = params.get(descriptor.key) ?? undefined;
        break;
      case 'multiSelect':
        raw[descriptor.key] = params.getAll(descriptor.key);
        break;
      case 'boolean': {
        const flag = params.get(descriptor.key);
        raw[descriptor.key] = flag === '1' || flag === 'true';
        break;
      }
      case 'dateRange':
        raw[descriptor.key] = {
          from: params.get(`${descriptor.key}From`) ?? undefined,
          to: params.get(`${descriptor.key}To`) ?? undefined,
        };
        break;
    }
  }

  return validateFilters(raw, descriptors);
}

export function countActiveFilters(descriptors: FilterDescriptor[], state: FilterState): number {
  return descriptors.filter(
    (descriptor) => normalizeFilterValue(descriptor.kind, state[descriptor.key]) !== undefined
  ).length;
}

/** A chip with an empty `value` renders as its label alone, which is all a
 *  boolean filter has to say. An inline field is its own chip: the typed query
 *  is already in the box beside the row. */
export function activeFilterChips(
  descriptors: FilterDescriptor[],
  state: FilterState
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.inline) continue;
    const value = normalizeFilterValue(descriptor.kind, state[descriptor.key]);
    if (value === undefined) continue;

    switch (descriptor.kind) {
      case 'search':
        if (typeof value === 'string') {
          chips.push({ key: descriptor.key, label: descriptor.label, value });
        }
        break;
      case 'select': {
        if (typeof value !== 'string') break;
        const option = descriptor.options?.find((entry) => entry.value === value);
        chips.push({ key: descriptor.key, label: descriptor.label, value: option?.label ?? value });
        break;
      }
      case 'multiSelect': {
        if (!Array.isArray(value)) break;
        const [first] = value;
        const single =
          descriptor.options?.find((option) => option.value === first)?.label ?? first ?? '';
        chips.push({
          key: descriptor.key,
          label: descriptor.label,
          value: value.length === 1 ? single : descriptor.countLabel(value.length),
        });
        break;
      }
      case 'dateRange':
        if (isDateRangeValue(value)) {
          chips.push({
            key: descriptor.key,
            label: descriptor.label,
            value: descriptor.formatValue(value),
          });
        }
        break;
      case 'boolean':
        chips.push({ key: descriptor.key, label: descriptor.label, value: '' });
        break;
    }
  }

  return chips;
}
