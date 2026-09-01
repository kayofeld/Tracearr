import {
  columnVisibilityFeature,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_alphanumericCaseSensitive,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  sortFn_textCaseSensitive,
  tableFeatures,
  type useTable,
} from '@tanstack/react-table';

/**
 * Per-column presentation hints. This is the `columnMeta` feature slot rather
 * than a `declare module` augmentation: declaration merging is global and would
 * apply these keys to every table in the app.
 */
export interface DataTableColumnMeta {
  align?: 'start' | 'center' | 'end';
  /** Right-aligns unless `align` says otherwise, and uses tabular figures. */
  numeric?: boolean;
  /** Extra classes on the header cell, e.g. `hidden md:table-cell`. */
  headerClassName?: string;
  /** Extra classes on the body cell, e.g. `hidden md:table-cell`. */
  cellClassName?: string;
  /** CSS length written onto both the header and body cell, e.g. `12rem`. */
  width?: string;
}

/**
 * One module-scope registry shared by every table. Recreating it per render
 * invalidates the row and column models on every pass.
 */
export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    alphanumericCaseSensitive: sortFn_alphanumericCaseSensitive,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
    textCaseSensitive: sortFn_textCaseSensitive,
  },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

type DataTableOptions<TData extends object> = Parameters<
  typeof useTable<DataTableFeatures, TData>
>[0];

/** The column-array type `useTable` accepts, without restating its generics. */
export type DataTableColumns<TData extends object> = DataTableOptions<TData>['columns'];

export type DataTableInstance<TData extends object> = ReturnType<
  typeof useTable<DataTableFeatures, TData>
>;

/** `createColumnHelper` with the shared feature registry already applied. */
export function createDataTableColumnHelper<TData extends object>() {
  return createColumnHelper<DataTableFeatures, TData>();
}
