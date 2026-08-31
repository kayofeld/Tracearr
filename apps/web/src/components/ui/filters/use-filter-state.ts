import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  filtersFromSearchParams,
  filtersToSearchParams,
  setFilterValue,
  validateFilters,
} from './filter-utils';
import type { FilterDescriptor, FilterState, FilterValue } from './types';

export type FilterPersistence = 'url' | 'local' | 'memory';

export interface UseFilterStateOptions<S extends FilterState> {
  descriptors: FilterDescriptor[];
  /** Define this at module scope: it is both the initial state and what
   *  "clear all" resolves to. */
  defaults: S;
  persistence?: FilterPersistence;
  /** Required by `persistence: 'local'`; ignored otherwise. */
  storageKey?: string;
}

export interface UseFilterStateResult<S extends FilterState> {
  filters: S;
  setFilters: (next: S) => void;
  setFilter: (key: string, value: FilterValue) => void;
  reset: () => void;
}

function readStoredFilters<S extends FilterState>(storageKey: string | undefined, defaults: S): S {
  if (!storageKey) return defaults;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaults;
    return { ...defaults, ...(JSON.parse(raw) as Partial<S>) };
  } catch {
    return defaults;
  }
}

function writeStoredFilters(storageKey: string | undefined, filters: FilterState): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(filters));
  } catch {
    /* private browsing / storage full - filters just won't survive this reload */
  }
}

/**
 * Filter state with a choice of where it lives.
 *
 * `useSearchParams` is called for every mode, so the hook needs a Router above
 * it whichever persistence is chosen.
 *
 * Validation runs on read rather than as an effect: a value the descriptors no
 * longer recognise never reaches the caller, and no write-back loop can form.
 * The stale entry stays in the URL or in storage until the next edit
 * overwrites it, where it is inert.
 */
export function useFilterState<S extends FilterState>({
  descriptors,
  defaults,
  persistence = 'memory',
  storageKey,
}: UseFilterStateOptions<S>): UseFilterStateResult<S> {
  const [searchParams, setSearchParams] = useSearchParams();
  const [stored, setStored] = useState<S>(() =>
    persistence === 'local' ? readStoredFilters(storageKey, defaults) : defaults
  );

  const filters = useMemo(() => {
    const raw =
      persistence === 'url'
        ? { ...defaults, ...filtersFromSearchParams(searchParams, descriptors) }
        : stored;
    return validateFilters(raw, descriptors);
  }, [persistence, defaults, searchParams, descriptors, stored]);

  const setFilters = useCallback(
    (next: S) => {
      if (persistence === 'url') {
        setSearchParams((prev) => filtersToSearchParams(next, descriptors, prev), {
          replace: true,
        });
        return;
      }
      setStored(next);
      if (persistence === 'local') writeStoredFilters(storageKey, next);
    },
    [persistence, descriptors, storageKey, setSearchParams]
  );

  const setFilter = useCallback(
    (key: string, value: FilterValue) => setFilters(setFilterValue(filters, key, value)),
    [filters, setFilters]
  );

  const reset = useCallback(() => setFilters(defaults), [defaults, setFilters]);

  return { filters, setFilters, setFilter, reset };
}
