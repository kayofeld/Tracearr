import { useState, useCallback, useEffect, useMemo } from 'react';

export type SelectionMode = 'none' | 'partial' | 'page' | 'all';

/** The load a selection was captured from, so cross-page picks survive a refetch. */
type LoadKey = string | number;

interface SelectedEntry<TData> {
  row: TData;
  loadKey: LoadKey;
}

export interface UseRowSelectionOptions<TData> {
  /** Function to get unique ID from a row */
  getRowId: (row: TData) => string;
  /** Total count of items matching current filters (for "select all" mode) */
  totalCount?: number;
  /**
   * The currently loaded rows. Passing them turns on reconciliation: a selected
   * row that its own load stops returning is dropped, while rows picked from
   * another page are left alone.
   */
  loadedRows?: TData[];
  /** Identifies which slice `loadedRows` came from, normally the page number. */
  loadKey?: LoadKey;
}

export interface UseRowSelectionReturn<TData> {
  /** Set of currently selected row IDs */
  selectedIds: Set<string>;
  /** The selected rows themselves, including ones from pages no longer loaded */
  selectedRows: TData[];
  /** Whether "select all matching" mode is active */
  selectAllMode: boolean;
  /** Current selection mode for UI indication */
  selectionMode: SelectionMode;
  /** Count of selected items (or total if selectAll) */
  selectedCount: number;
  /** Check if a specific row is selected */
  isSelected: (row: TData) => boolean;
  /** Toggle selection of a single row */
  toggleRow: (row: TData) => void;
  /** Toggle all rows on current page */
  togglePage: (pageRows: TData[]) => void;
  /** Select all items matching current filters */
  selectAll: () => void;
  /** Clear all selection */
  clearSelection: () => void;
  /** Check if all rows on current page are selected */
  isPageSelected: (pageRows: TData[]) => boolean;
  /** Check if some (but not all) rows on current page are selected */
  isPageIndeterminate: (pageRows: TData[]) => boolean;
}

export function useRowSelection<TData>({
  getRowId,
  totalCount = 0,
  loadedRows,
  loadKey = 0,
}: UseRowSelectionOptions<TData>): UseRowSelectionReturn<TData> {
  const [selected, setSelected] = useState<Map<string, SelectedEntry<TData>>>(() => new Map());
  const [selectAllMode, setSelectAllMode] = useState(false);

  useEffect(() => {
    if (!loadedRows) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const present = new Map(loadedRows.map((row) => [getRowId(row), row]));
      const next = new Map(prev);
      let changed = false;
      for (const [id, entry] of prev) {
        const fresh = present.get(id);
        if (fresh !== undefined) {
          if (fresh !== entry.row) {
            next.set(id, { row: fresh, loadKey });
            changed = true;
          }
        } else if (entry.loadKey === loadKey) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [loadedRows, loadKey, getRowId]);

  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);

  const selectedRows = useMemo(
    () => Array.from(selected.values(), (entry) => entry.row),
    [selected]
  );

  const selectedCount = selectAllMode ? totalCount : selected.size;

  const selectionMode = useMemo((): SelectionMode => {
    if (selectAllMode) return 'all';
    if (selected.size === 0) return 'none';
    return 'partial';
  }, [selectAllMode, selected.size]);

  const isSelected = useCallback(
    (row: TData): boolean => {
      if (selectAllMode) return true;
      return selected.has(getRowId(row));
    },
    [selectAllMode, selected, getRowId]
  );

  const toggleRow = useCallback(
    (row: TData) => {
      const id = getRowId(row);
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.set(id, { row, loadKey });
        }
        return next;
      });
      setSelectAllMode(false);
    },
    [getRowId, loadKey]
  );

  const togglePage = useCallback(
    (pageRows: TData[]) => {
      setSelected((prev) => {
        const next = new Map(prev);
        const allSelected = pageRows.every((row) => next.has(getRowId(row)));
        for (const row of pageRows) {
          const id = getRowId(row);
          if (allSelected) {
            next.delete(id);
          } else {
            next.set(id, { row, loadKey });
          }
        }
        return next;
      });
      setSelectAllMode(false);
    },
    [getRowId, loadKey]
  );

  const selectAll = useCallback(() => {
    setSelectAllMode(true);
    setSelected(new Map());
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setSelectAllMode(false);
  }, []);

  const isPageSelected = useCallback(
    (pageRows: TData[]): boolean => {
      if (selectAllMode) return true;
      if (pageRows.length === 0) return false;
      return pageRows.every((row) => selected.has(getRowId(row)));
    },
    [selectAllMode, selected, getRowId]
  );

  const isPageIndeterminate = useCallback(
    (pageRows: TData[]): boolean => {
      if (selectAllMode) return false;
      if (pageRows.length === 0) return false;
      const selectedOnPage = pageRows.filter((row) => selected.has(getRowId(row)));
      return selectedOnPage.length > 0 && selectedOnPage.length < pageRows.length;
    },
    [selectAllMode, selected, getRowId]
  );

  return {
    selectedIds,
    selectedRows,
    selectAllMode,
    selectionMode,
    selectedCount,
    isSelected,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
    isPageSelected,
    isPageIndeterminate,
  };
}
