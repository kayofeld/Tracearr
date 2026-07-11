import { useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type SortingState } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { User, AlertTriangle, Check, X, Filter, Trash2, UserRoundSearch } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { ViolationWithDetails, ViolationSeverity, ViolationSortField } from '@tracearr/shared';
import {
  useViolations,
  useAcknowledgeViolation,
  useDismissViolation,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
  useUsers,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { ServerColumnCell } from '@/components/server';
import { useRowSelection } from '@/hooks/useRowSelection';

import { ruleIcons } from '@/components/violations/ruleIcons';
import { PersonMultiSelectCombobox } from '@/components/violations/PersonMultiSelectCombobox';
import { ErrorState } from '@/components/library/ErrorState';
import { buildViolationFilterParams } from './violationsFilters';

// Map DataTable column IDs to API sort field names
const columnToSortField: Record<string, ViolationSortField> = {
  createdAt: 'createdAt',
  severity: 'severity',
  user: 'user',
  rule: 'rule',
};

export function Violations() {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [severityFilter, setSeverityFilter] = useState<ViolationSeverity | 'all'>('all');
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<'all' | 'pending' | 'acknowledged'>(
    'all'
  );
  // Identity-level filter (users.id values), not server account ids - each
  // selected person matches every account they have on servers the caller
  // can access. Empty array means no person filter is active.
  const [personFilter, setPersonFilter] = useState<string[]>([]);
  const [personSearch, setPersonSearch] = useState('');
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [bulkDismissConfirmOpen, setBulkDismissConfirmOpen] = useState(false);
  const pageSize = 10;
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const colorMap = useServerColorMap();

  // Convert sorting state to API params
  const orderBy = sorting[0]?.id ? columnToSortField[sorting[0].id] : undefined;
  const orderDir = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : undefined;

  // Current filter params - shared by the list query and the bulk "select all
  // matching" filters below, so select-all can never touch more violations
  // than what the list itself is currently showing.
  const currentFilters = useMemo(
    () =>
      buildViolationFilterParams({
        severityFilter,
        acknowledgedFilter,
        personFilter,
        selectedServerIds,
      }),
    [severityFilter, acknowledgedFilter, personFilter, selectedServerIds]
  );

  const {
    data: violationsData,
    isLoading,
    isError,
    error,
    refetch,
  } = useViolations({
    page,
    pageSize,
    ...currentFilters,
    orderBy,
    orderDir,
  });
  const acknowledgeViolation = useAcknowledgeViolation();
  const dismissViolation = useDismissViolation();
  const bulkAcknowledge = useBulkAcknowledgeViolations();
  const bulkDismiss = useBulkDismissViolations();

  // Person filter options - one entry per identity, scoped to the currently
  // selected servers so the picker never offers someone the caller can't see.
  // Search is server-side (see useUsers `search`) since the roster can exceed
  // the page fetched here.
  const {
    data: personOptionsData,
    isLoading: personOptionsLoading,
    isError: personOptionsError,
  } = useUsers({
    pageSize: 100,
    serverIds: selectedServerIds.length > 0 ? selectedServerIds : undefined,
    search: personSearch || undefined,
  });
  const personOptions = useMemo(() => personOptionsData?.data ?? [], [personOptionsData]);

  const violations = violationsData?.data ?? [];
  const totalPages = violationsData?.totalPages ?? 1;
  const total = violationsData?.total ?? 0;

  // Display info for every selected person, used by the summary card(s) and
  // as a name-resolution fallback for the trigger summary - prefer the
  // roster option (has identityServers for the server badges), falling back
  // to the currently loaded violation rows so the summary still renders even
  // if the person filter came from a row action or search page that doesn't
  // include this person in the currently loaded options.
  const selectedPeople = useMemo(() => {
    return personFilter
      .map((id) => {
        const fromOptions = personOptions.find((option) => option.userId === id);
        if (fromOptions) return fromOptions;
        const fromRow = violations.find((v) => v.user.userId === id);
        if (!fromRow) return undefined;
        return {
          userId: id,
          identityName: fromRow.user.identityName,
          username: fromRow.user.username,
          thumbUrl: fromRow.user.thumbUrl,
          serverId: fromRow.user.serverId,
          identityServers: undefined as { id: string; name: string }[] | undefined,
        };
      })
      .filter((person): person is NonNullable<typeof person> => person !== undefined);
  }, [personFilter, personOptions, violations]);

  const resolvePersonName = useCallback(
    (id: string) => {
      const person = selectedPeople.find((p) => p.userId === id);
      return person ? (person.identityName ?? person.username) : undefined;
    },
    [selectedPeople]
  );

  // Row selection
  const {
    selectedIds,
    selectAllMode,
    selectedCount,
    isSelected: _isSelected,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
    isPageSelected,
    isPageIndeterminate,
  } = useRowSelection({
    getRowId: (row: ViolationWithDetails) => row.id,
    totalCount: total,
  });

  const handlePersonFilterChange = useCallback(
    (userIds: string[]) => {
      setPersonFilter(userIds);
      setPage(1);
      clearSelection();
    },
    [clearSelection]
  );

  // Row-level "filter by this person" action: sets the person as the only
  // active filter when nothing is selected yet (the icon means "show me
  // this person"), otherwise adds them to the existing multi-selection. A
  // person already in the selection is left as-is.
  const handleAddPersonToFilter = useCallback(
    (userId: string) => {
      setPersonFilter((prev) => {
        if (prev.includes(userId)) return prev;
        return prev.length === 0 ? [userId] : [...prev, userId];
      });
      setPage(1);
      clearSelection();
    },
    [clearSelection]
  );

  const handleAcknowledge = (id: string) => {
    acknowledgeViolation.mutate(id);
  };

  const handleDismiss = (id?: string) => {
    const violationId = id || dismissId;
    if (violationId) {
      dismissViolation.mutate(violationId, {
        onSuccess: () => {
          setDismissId(null);
        },
      });
    }
  };

  const handleBulkAcknowledge = () => {
    if (selectAllMode) {
      bulkAcknowledge.mutate(
        { selectAll: true, filters: currentFilters },
        { onSuccess: clearSelection }
      );
    } else {
      bulkAcknowledge.mutate({ ids: Array.from(selectedIds) }, { onSuccess: clearSelection });
    }
  };

  const handleBulkDismiss = () => {
    if (selectAllMode) {
      bulkDismiss.mutate(
        { selectAll: true, filters: currentFilters },
        {
          onSuccess: () => {
            clearSelection();
            setBulkDismissConfirmOpen(false);
          },
        }
      );
    } else {
      bulkDismiss.mutate(
        { ids: Array.from(selectedIds) },
        {
          onSuccess: () => {
            clearSelection();
            setBulkDismissConfirmOpen(false);
          },
        }
      );
    }
  };

  const handleSortingChange = useCallback((newSorting: SortingState) => {
    setSorting(newSorting);
    setPage(1);
  }, []);

  const bulkActions: BulkAction[] = [
    {
      key: 'acknowledge',
      label: t('common:actions.acknowledge'),
      icon: <Check className="h-4 w-4" />,
      variant: 'default',
      onClick: handleBulkAcknowledge,
      isLoading: bulkAcknowledge.isPending,
    },
    {
      key: 'dismiss',
      label: t('common:actions.dismiss'),
      icon: <Trash2 className="h-4 w-4" />,
      variant: 'destructive',
      onClick: () => setBulkDismissConfirmOpen(true),
      isLoading: bulkDismiss.isPending,
    },
  ];

  const violationColumns: ColumnDef<ViolationWithDetails>[] = useMemo(
    () => [
      ...(isMultiServer
        ? [
            {
              id: 'server',
              header: t('common:labels.server'),
              cell: ({ row }: { row: { original: ViolationWithDetails } }) => {
                const server =
                  (row.original.server?.id
                    ? selectedServers.find((s) => s.id === row.original.server!.id)
                    : undefined) ?? row.original.server;
                return server ? <ServerColumnCell server={server} /> : null;
              },
            } satisfies ColumnDef<ViolationWithDetails>,
          ]
        : []),
      {
        accessorKey: 'user',
        header: t('common:labels.user'),
        cell: ({ row }) => {
          const violation = row.original;
          const avatarUrl = getAvatarUrl(violation.user.serverId, violation.user.thumbUrl, 40);
          return (
            <div className="flex items-center gap-1">
              <Link
                to={`/users/${violation.user.id}`}
                className="flex min-w-0 items-center gap-3 hover:underline"
              >
                <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={violation.user.username}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <User className="text-muted-foreground h-5 w-5" />
                  )}
                </div>
                <span className="truncate font-medium">
                  {violation.user.identityName ?? violation.user.username}
                </span>
              </Link>
              {violation.user.userId && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
                  title={t('pages:violations.filterByPerson')}
                  aria-label={t('pages:violations.filterByPerson')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (violation.user.userId) {
                      handleAddPersonToFilter(violation.user.userId);
                    }
                  }}
                >
                  <UserRoundSearch className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'rule',
        header: t('common:labels.rule'),
        cell: ({ row }) => {
          const violation = row.original;
          return (
            <div className="flex items-center gap-2">
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                {(violation.rule.type && ruleIcons[violation.rule.type]) ?? (
                  <AlertTriangle className="h-4 w-4" />
                )}
              </div>
              <div>
                <p className="font-medium">{violation.rule.name}</p>
                <p className="text-muted-foreground text-xs capitalize">
                  {violation.rule.type?.replace(/_/g, ' ') ?? 'Custom Rule'}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'severity',
        header: t('common:labels.severity'),
        cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      },
      {
        accessorKey: 'createdAt',
        header: t('common:labels.when'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: t('common:labels.status'),
        cell: ({ row }) => (
          <span
            className={
              row.original.acknowledgedAt ? 'text-muted-foreground' : 'font-medium text-yellow-500'
            }
          >
            {row.original.acknowledgedAt
              ? t('common:states.acknowledged')
              : t('common:states.pending')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const violation = row.original;
          return (
            <div
              className="flex items-center gap-2"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              {!violation.acknowledgedAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAcknowledge(violation.id);
                  }}
                  disabled={acknowledgeViolation.isPending}
                  className="text-green-600 hover:text-green-700 dark:text-green-500 dark:hover:text-green-400"
                >
                  <Check className="mr-1 h-4 w-4" />
                  {t('common:actions.acknowledge')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setDismissId(violation.id);
                }}
                className="text-destructive hover:text-destructive"
              >
                <X className="mr-1 h-4 w-4" />
                {t('common:actions.dismiss')}
              </Button>
            </div>
          );
        },
      },
    ],
    [
      t,
      handleAcknowledge,
      acknowledgeViolation.isPending,
      isMultiServer,
      selectedServers,
      handleAddPersonToFilter,
    ]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('violations.title')}</h1>
          <p className="text-muted-foreground">{t('common:count.violation', { count: total })}</p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" />
            {t('common:labels.filters')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-2">
              <label className="text-muted-foreground text-sm">{t('common:labels.severity')}</label>
              <Select
                value={severityFilter}
                onValueChange={(value) => {
                  setSeverityFilter(value as ViolationSeverity | 'all');
                  setPage(1);
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pages:violations.allSeverities')}</SelectItem>
                  <SelectItem value="high">{t('common:severity.high')}</SelectItem>
                  <SelectItem value="warning">{t('common:severity.warning')}</SelectItem>
                  <SelectItem value="low">{t('common:severity.low')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-muted-foreground text-sm">{t('common:labels.status')}</label>
              <Select
                value={acknowledgedFilter}
                onValueChange={(value) => {
                  setAcknowledgedFilter(value as 'all' | 'pending' | 'acknowledged');
                  setPage(1);
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pages:violations.allStatuses')}</SelectItem>
                  <SelectItem value="pending">{t('common:states.pending')}</SelectItem>
                  <SelectItem value="acknowledged">{t('common:states.acknowledged')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="violations-person-filter" className="text-muted-foreground text-sm">
                {t('pages:violations.filterPeople')}
              </label>
              <PersonMultiSelectCombobox
                triggerId="violations-person-filter"
                value={personFilter}
                onChange={handlePersonFilterChange}
                options={personOptions}
                onSearchChange={setPersonSearch}
                isLoading={personOptionsLoading}
                isError={personOptionsError}
                resolveExtraName={resolvePersonName}
                allLabel={t('pages:violations.allPeople')}
                countLabel={(count) => t('pages:violations.peopleSelectedCount', { count })}
                searchPlaceholder={t('pages:violations.personFilterPlaceholder')}
                emptyMessage={t('pages:violations.personFilterEmpty')}
                errorMessage={t('pages:violations.personFilterError')}
                loadingMessage={t('common:states.loading')}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Person filter summary - a single card when filtering to one person's
          record, or a compact combined strip when several are selected. */}
      {selectedPeople.length === 1 && selectedPeople[0] && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  src={
                    getAvatarUrl(selectedPeople[0].serverId, selectedPeople[0].thumbUrl, 40) ??
                    undefined
                  }
                />
                <AvatarFallback>
                  {(selectedPeople[0].identityName ??
                    selectedPeople[0].username)[0]?.toUpperCase() ?? '?'}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">
                  {selectedPeople[0].identityName ?? selectedPeople[0].username}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('common:count.violation', { count: total })}
                </p>
              </div>
            </div>
            {selectedPeople[0].identityServers && selectedPeople[0].identityServers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedPeople[0].identityServers.map((server) => (
                  <ServerColumnCell key={server.id} server={server} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {selectedPeople.length > 1 && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap gap-3">
              {selectedPeople.map((person) => (
                <div
                  key={person.userId}
                  className="bg-muted/50 flex items-center gap-2 rounded-full py-1 pr-3 pl-1"
                >
                  <Avatar className="h-6 w-6">
                    <AvatarImage
                      src={getAvatarUrl(person.serverId, person.thumbUrl, 24) ?? undefined}
                    />
                    <AvatarFallback className="text-[10px]">
                      {(person.identityName ?? person.username)[0]?.toUpperCase() ?? '?'}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium">
                    {person.identityName ?? person.username}
                  </span>
                  {person.identityServers && person.identityServers.length > 0 && (
                    <div className="flex gap-1">
                      {person.identityServers.map((server) => (
                        <ServerColumnCell key={server.id} server={server} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">
              {t('common:count.violation', { count: total })}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Violations Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('violations.violationLog')}</CardTitle>
          {selectedCount > 0 && !selectAllMode && total > selectedCount && (
            <Button variant="link" size="sm" onClick={selectAll} className="text-sm">
              {t('violations.selectAllViolations', { count: total })}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : isError ? (
            <ErrorState
              title={t('common:errors.somethingWentWrong')}
              message={error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void refetch()}
            />
          ) : violations.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-4">
              <AlertTriangle className="text-muted-foreground h-12 w-12" />
              <div className="text-center">
                <h3 className="font-semibold">{t('violations.noViolationsFound')}</h3>
                <p className="text-muted-foreground text-sm">
                  {severityFilter !== 'all' ||
                  acknowledgedFilter !== 'all' ||
                  personFilter.length > 0
                    ? t('violations.tryAdjustingFilters')
                    : t('violations.noViolationsRecorded')}
                </p>
              </div>
            </div>
          ) : (
            <DataTable
              columns={violationColumns}
              data={violations}
              pageSize={pageSize}
              pageCount={totalPages}
              page={page}
              onPageChange={setPage}
              sorting={sorting}
              onSortingChange={handleSortingChange}
              isServerFiltered
              onRowClick={(violation) => {
                void navigate(`/violations/${violation.id}`);
              }}
              emptyMessage={t('violations.noViolationsFound')}
              selectable
              getRowId={(row) => row.id}
              selectedIds={selectedIds}
              selectAllMode={selectAllMode}
              onRowSelect={toggleRow}
              onPageSelect={togglePage}
              isPageSelected={isPageSelected(violations)}
              isPageIndeterminate={isPageIndeterminate(violations)}
              getRowStyle={
                isMultiServer
                  ? (row) => {
                      const color = row.server?.id ? (colorMap.get(row.server.id) ?? null) : null;
                      return color ? { boxShadow: `inset 3px 0 0 0 ${color}` } : undefined;
                    }
                  : undefined
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        selectAllMode={selectAllMode}
        totalCount={total}
        actions={bulkActions}
        onClearSelection={clearSelection}
      />

      {/* Dismiss Confirmation Dialog */}
      <Dialog
        open={!!dismissId}
        onOpenChange={() => {
          setDismissId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages:violations.dismissViolation')}</DialogTitle>
            <DialogDescription>{t('pages:violations.dismissViolationConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDismissId(null);
              }}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleDismiss()}
              disabled={dismissViolation.isPending}
            >
              {dismissViolation.isPending
                ? t('common:states.dismissing')
                : t('common:actions.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Dismiss Confirmation Dialog */}
      <Dialog open={bulkDismissConfirmOpen} onOpenChange={setBulkDismissConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('pages:violations.dismissViolation', {
                count: selectAllMode ? total : selectedCount,
              })}
            </DialogTitle>
            <DialogDescription>{t('pages:violations.dismissViolationsConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDismissConfirmOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDismiss}
              disabled={bulkDismiss.isPending}
            >
              {bulkDismiss.isPending
                ? t('common:states.dismissing')
                : t('pages:violations.dismissViolation', {
                    count: selectAllMode ? total : selectedCount,
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
