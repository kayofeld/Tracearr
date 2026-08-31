import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRowSelection } from './useRowSelection';

interface Person {
  id: string;
  name: string;
}

const pageOne: Person[] = [
  { id: 'a', name: 'Ada' },
  { id: 'b', name: 'Bob' },
];
const pageTwo: Person[] = [
  { id: 'c', name: 'Cleo' },
  { id: 'd', name: 'Dan' },
];

const getRowId = (row: Person) => row.id;

describe('useRowSelection', () => {
  it('keeps the row objects for picks made on different pages', () => {
    const { result, rerender } = renderHook(
      ({ rows, page }: { rows: Person[]; page: number }) =>
        useRowSelection({ getRowId, totalCount: 4, loadedRows: rows, loadKey: page }),
      { initialProps: { rows: pageOne, page: 1 } }
    );

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    rerender({ rows: pageTwo, page: 2 });
    act(() => {
      result.current.toggleRow(pageTwo[1]!);
    });

    expect(result.current.selectedCount).toBe(2);
    expect(result.current.selectedRows).toEqual([
      { id: 'a', name: 'Ada' },
      { id: 'd', name: 'Dan' },
    ]);
    expect(Array.from(result.current.selectedIds)).toEqual(['a', 'd']);
  });

  it('deselects by dropping the id rather than keeping a false entry', () => {
    const { result } = renderHook(() => useRowSelection({ getRowId, totalCount: 2 }));

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });

    expect(result.current.selectedIds.has('a')).toBe(false);
    expect(Array.from(result.current.selectedIds)).toEqual([]);
    expect(result.current.selectedRows).toEqual([]);
    expect(result.current.selectionMode).toBe('none');
  });

  it('drops a selected row that its own page stops returning', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: Person[] }) =>
        useRowSelection({ getRowId, totalCount: 2, loadedRows: rows, loadKey: 1 }),
      { initialProps: { rows: pageOne } }
    );

    act(() => {
      result.current.togglePage(pageOne);
    });
    expect(result.current.selectedCount).toBe(2);

    rerender({ rows: [{ id: 'b', name: 'Bob' }] });

    expect(Array.from(result.current.selectedIds)).toEqual(['b']);
    expect(result.current.selectedRows).toEqual([{ id: 'b', name: 'Bob' }]);
  });

  it('leaves picks from other pages alone while reconciling the loaded one', () => {
    const { result, rerender } = renderHook(
      ({ rows, page }: { rows: Person[]; page: number }) =>
        useRowSelection({ getRowId, totalCount: 4, loadedRows: rows, loadKey: page }),
      { initialProps: { rows: pageOne, page: 1 } }
    );

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    rerender({ rows: pageTwo, page: 2 });
    act(() => {
      result.current.toggleRow(pageTwo[0]!);
    });

    rerender({ rows: [{ id: 'd', name: 'Dan' }], page: 2 });

    expect(Array.from(result.current.selectedIds)).toEqual(['a']);
    expect(result.current.selectedRows).toEqual([{ id: 'a', name: 'Ada' }]);
  });

  it('refreshes the stored row object when a refetch returns new data for it', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: Person[] }) =>
        useRowSelection({ getRowId, totalCount: 2, loadedRows: rows, loadKey: 1 }),
      { initialProps: { rows: pageOne } }
    );

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    rerender({ rows: [{ id: 'a', name: 'Ada Lovelace' }, pageOne[1]!] });

    expect(result.current.selectedRows).toEqual([{ id: 'a', name: 'Ada Lovelace' }]);
  });

  it('reports select-all mode against the total and clears the id map', () => {
    const { result } = renderHook(() => useRowSelection({ getRowId, totalCount: 97 }));

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    act(() => {
      result.current.selectAll();
    });

    expect(result.current.selectAllMode).toBe(true);
    expect(result.current.selectedCount).toBe(97);
    expect(result.current.selectionMode).toBe('all');
    expect(result.current.selectedRows).toEqual([]);
    expect(result.current.isSelected(pageTwo[0]!)).toBe(true);
    expect(result.current.isPageIndeterminate(pageOne)).toBe(false);

    act(() => {
      result.current.toggleRow(pageOne[1]!);
    });
    expect(result.current.selectAllMode).toBe(false);
    expect(result.current.selectedRows).toEqual([{ id: 'b', name: 'Bob' }]);
  });

  it('toggles a whole page on and back off', () => {
    const { result } = renderHook(() => useRowSelection({ getRowId, totalCount: 4 }));

    act(() => {
      result.current.togglePage(pageOne);
    });
    expect(result.current.isPageSelected(pageOne)).toBe(true);
    expect(result.current.isPageIndeterminate(pageOne)).toBe(false);

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    expect(result.current.isPageIndeterminate(pageOne)).toBe(true);

    act(() => {
      result.current.togglePage(pageOne);
    });
    expect(result.current.selectedCount).toBe(2);

    act(() => {
      result.current.togglePage(pageOne);
    });
    expect(result.current.selectedCount).toBe(0);
  });

  it('does not reconcile when no loaded rows are supplied', () => {
    const { result, rerender } = renderHook(() => useRowSelection({ getRowId, totalCount: 2 }));

    act(() => {
      result.current.toggleRow(pageOne[0]!);
    });
    rerender();

    expect(Array.from(result.current.selectedIds)).toEqual(['a']);
  });
});
