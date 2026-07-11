import { useState, useMemo, type CSSProperties } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type FilterFn,
  type RowData,
} from '@tanstack/react-table';

export type { SortingState };
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- names must match the augmented interface
  interface ColumnMeta<TData extends RowData, TValue> {
    // Extra classes applied to this column's header/cell, e.g. to collapse it
    // on narrow viewports ('hidden md:table-cell').
    headerClassName?: string;
    cellClassName?: string;
  }
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pageSize?: number;
  onRowClick?: (row: TData) => void;
  emptyMessage?: string;
  className?: string;
  compact?: boolean;
  // Server-side pagination props
  pageCount?: number;
  page?: number;
  onPageChange?: (page: number) => void;
  isLoading?: boolean;
  // Server-side sorting props
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  // Client-side filtering props (skip if data is pre-filtered from server)
  filterColumn?: string;
  filterValue?: string;
  // Set to true when data arrives pre-filtered from server (skips client-side filtering)
  isServerFiltered?: boolean;
  // Row selection props
  selectable?: boolean;
  getRowId?: (row: TData) => string;
  selectedIds?: Set<string>;
  selectAllMode?: boolean;
  onRowSelect?: (row: TData) => void;
  onPageSelect?: (rows: TData[]) => void;
  isPageSelected?: boolean;
  isPageIndeterminate?: boolean;
  // Optional per-row inline style (e.g. server color accent)
  getRowStyle?: (row: TData) => CSSProperties | undefined;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pageSize = 10,
  onRowClick,
  emptyMessage = 'No results found.',
  className,
  compact = false,
  pageCount,
  page,
  onPageChange,
  isLoading,
  sorting: externalSorting,
  onSortingChange,
  filterColumn,
  filterValue,
  isServerFiltered = false,
  // Selection props
  selectable = false,
  getRowId,
  selectedIds,
  selectAllMode = false,
  onRowSelect,
  onPageSelect,
  isPageSelected = false,
  isPageIndeterminate: _isPageIndeterminate = false,
  getRowStyle,
}: DataTableProps<TData, TValue>) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: page ? page - 1 : 0,
    pageSize,
  });

  const isServerPaginated = pageCount !== undefined && onPageChange !== undefined;
  const isServerSorted = onSortingChange !== undefined;
  const sorting = externalSorting ?? internalSorting;

  // Custom filter function that searches in the specified column
  const globalFilterFn: FilterFn<TData> = useMemo(() => {
    return (row, _columnId, filterValue: string) => {
      if (!filterColumn || !filterValue) return true;
      const cellValue = row.getValue(filterColumn);
      if (cellValue == null) return false;
      return String(cellValue).toLowerCase().includes(filterValue.toLowerCase());
    };
  }, [filterColumn]);

  const handleSortingChange = (updater: SortingState | ((old: SortingState) => SortingState)) => {
    const newSorting = typeof updater === 'function' ? updater(sorting) : updater;
    if (isServerSorted) {
      onSortingChange(newSorting);
    } else {
      setInternalSorting(newSorting);
    }
  };

  // Build columns with optional checkbox column
  const allColumns = useMemo(() => {
    if (!selectable) return columns;

    const checkboxColumn: ColumnDef<TData, TValue> = {
      id: '_select',
      header: () => (
        <Checkbox
          checked={selectAllMode || isPageSelected}
          onCheckedChange={() => onPageSelect?.(data)}
          aria-label="Select all on page"
        />
      ),
      cell: ({ row }) => {
        const rowId = getRowId?.(row.original) ?? '';
        const isSelected = selectAllMode || (selectedIds?.has(rowId) ?? false);
        return (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onRowSelect?.(row.original)}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
          />
        );
      },
      enableSorting: false,
      enableHiding: false,
    };

    return [checkboxColumn, ...columns];
  }, [
    selectable,
    columns,
    selectAllMode,
    isPageSelected,
    data,
    onPageSelect,
    getRowId,
    selectedIds,
    onRowSelect,
  ]);

  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: isServerSorted ? undefined : getSortedRowModel(),
    getFilteredRowModel: isServerFiltered ? undefined : getFilteredRowModel(),
    getPaginationRowModel: isServerPaginated ? undefined : getPaginationRowModel(),
    globalFilterFn: isServerFiltered ? undefined : globalFilterFn,
    onSortingChange: handleSortingChange,
    onPaginationChange: setPagination,
    manualPagination: isServerPaginated,
    manualSorting: isServerSorted,
    manualFiltering: isServerFiltered,
    pageCount: isServerPaginated ? pageCount : undefined,
    state: {
      sorting,
      globalFilter: isServerFiltered ? undefined : (filterValue ?? ''),
      pagination: isServerPaginated ? { pageIndex: (page ?? 1) - 1, pageSize } : pagination,
    },
  });

  const handlePageChange = (newPage: number) => {
    if (isServerPaginated && onPageChange) {
      onPageChange(newPage);
    }
  };

  const currentPage = isServerPaginated ? page : pagination.pageIndex + 1;
  const totalPages = isServerPaginated ? pageCount : table.getPageCount();
  const canPreviousPage = isServerPaginated ? (page ?? 1) > 1 : table.getCanPreviousPage();
  const canNextPage = isServerPaginated ? (page ?? 1) < (pageCount ?? 1) : table.getCanNextPage();

  const columnCount = allColumns.length;

  return (
    <div className={cn('space-y-4', className)}>
      <div className="rounded-md border">
        <Table>
          <TableHeader className="bg-muted/50">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      compact ? 'px-3 py-2' : 'px-4 py-3',
                      header.column.id === '_select' && 'w-12',
                      header.column.columnDef.meta?.headerClassName
                    )}
                  >
                    {header.isPlaceholder ? null : header.column.id === '_select' ? (
                      flexRender(header.column.columnDef.header, header.getContext())
                    ) : (
                      <div
                        className={cn(
                          'flex items-center gap-2',
                          header.column.getCanSort() &&
                            'hover:text-foreground cursor-pointer select-none'
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="ml-1">
                            {header.column.getIsSorted() === 'asc' ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : header.column.getIsSorted() === 'desc' ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronsUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={columnCount}
                  className="text-muted-foreground py-10 text-center"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                const rowId = getRowId?.(row.original) ?? '';
                const isRowSelected = selectAllMode || (selectedIds?.has(rowId) ?? false);
                return (
                  <TableRow
                    key={row.id}
                    className={cn(onRowClick && 'cursor-pointer', isRowSelected && 'bg-muted/50')}
                    style={getRowStyle?.(row.original)}
                    onClick={() => onRowClick?.(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          compact ? 'px-3 py-1.5' : 'px-4 py-3',
                          cell.column.id === '_select' && 'w-12',
                          cell.column.columnDef.meta?.cellClassName
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columnCount}
                  className="text-muted-foreground py-10 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Page {currentPage ?? 1} of {totalPages}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (isServerPaginated) {
                handlePageChange((page ?? 1) - 1);
              } else {
                table.previousPage();
              }
            }}
            disabled={!canPreviousPage}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (isServerPaginated) {
                handlePageChange((page ?? 1) + 1);
              } else {
                table.nextPage();
              }
            }}
            disabled={!canNextPage}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
