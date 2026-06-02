/**
 * History page - comprehensive session history with powerful filtering.
 * Features infinite scroll, URL state sync, column visibility, and aggregate statistics.
 */

import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import {
  HistoryFiltersBar,
  DEFAULT_COLUMN_VISIBILITY,
  type ColumnVisibility,
} from '@/components/history/HistoryFilters';
import { HistoryTable, type SortableColumn } from '@/components/history/HistoryTable';
import { HistoryAggregates } from '@/components/history/HistoryAggregates';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import {
  useHistorySessions,
  useHistoryAggregates,
  useFilterOptions,
  useSession,
  type HistoryFilters,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import type { SessionWithDetails } from '@tracearr/shared';

// Local storage key for column visibility
const COLUMN_VISIBILITY_KEY = 'tracearr-history-columns';

// Load column visibility from local storage
function loadColumnVisibility(): ColumnVisibility {
  try {
    const stored = localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ColumnVisibility>;
      // Merge with defaults to handle new columns
      return { ...DEFAULT_COLUMN_VISIBILITY, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_COLUMN_VISIBILITY;
}

// Save column visibility to local storage
function saveColumnVisibility(visibility: ColumnVisibility): void {
  try {
    localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    // Ignore storage errors
  }
}

function parseCommaSeparated<T extends string>(
  value: string | null,
  validValues?: readonly T[]
): T[] | undefined {
  if (!value) return undefined;
  const values = value.split(',').filter(Boolean) as T[];
  if (validValues) {
    const filtered = values.filter((v) => validValues.includes(v));
    return filtered.length > 0 ? filtered : undefined;
  }
  return values.length > 0 ? values : undefined;
}

// Parse URL search params into filter object
function parseFiltersFromUrl(searchParams: URLSearchParams): HistoryFilters {
  const filters: HistoryFilters = {};

  const userIds = searchParams.get('userIds');
  if (userIds) {
    const parsed = userIds.split(',').filter(Boolean);
    if (parsed.length > 0) filters.serverUserIds = parsed;
  }

  // serverIds=a,b is the canonical param; legacy serverId=X is back-compat
  const serverIdsParam = searchParams.get('serverIds');
  if (serverIdsParam) {
    const parsed = serverIdsParam.split(',').filter(Boolean);
    if (parsed.length > 0) filters.serverIds = parsed;
  } else {
    const legacyServerId = searchParams.get('serverId');
    if (legacyServerId) filters.serverIds = [legacyServerId];
  }

  const mediaTypes = parseCommaSeparated(searchParams.get('mediaTypes'), [
    'movie',
    'episode',
    'track',
    'live',
  ] as const);
  if (mediaTypes) filters.mediaTypes = mediaTypes;

  const state = searchParams.get('state');
  if (state === 'playing' || state === 'paused' || state === 'stopped') {
    filters.state = state;
  }

  const transcodeDecisions = parseCommaSeparated(searchParams.get('transcodeDecisions'), [
    'directplay',
    'copy',
    'transcode',
  ] as const);
  if (transcodeDecisions) filters.transcodeDecisions = transcodeDecisions;

  const platforms = parseCommaSeparated<string>(searchParams.get('platforms'));
  if (platforms) filters.platforms = platforms;

  const countries = parseCommaSeparated<string>(searchParams.get('countries'));
  if (countries) filters.geoCountries = countries;

  const search = searchParams.get('search');
  if (search) filters.search = search;

  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const period = searchParams.get('period');

  if (startDate) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) filters.startDate = parsed;
  }

  if (endDate) {
    const parsed = new Date(endDate);
    if (!isNaN(parsed.getTime())) filters.endDate = parsed;
  }

  // Default to 30d only on fresh page load (no period param)
  // If period=all, user explicitly wants all data
  if (!filters.startDate && !filters.endDate && period !== 'all') {
    const now = new Date();
    filters.startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    filters.endDate = now;
  }

  const watched = searchParams.get('watched');
  if (watched === 'true') filters.watched = true;
  if (watched === 'false') filters.watched = false;

  const orderBy = searchParams.get('orderBy');
  if (orderBy === 'startedAt' || orderBy === 'durationMs' || orderBy === 'mediaTitle') {
    filters.orderBy = orderBy;
  }

  const orderDir = searchParams.get('orderDir');
  if (orderDir === 'asc' || orderDir === 'desc') {
    filters.orderDir = orderDir;
  }

  return filters;
}

// Convert filter object to URL search params
function filtersToUrlParams(filters: HistoryFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.serverUserIds?.length) params.set('userIds', filters.serverUserIds.join(','));
  if (filters.serverIds?.length) params.set('serverIds', filters.serverIds.join(','));
  if (filters.mediaTypes?.length) params.set('mediaTypes', filters.mediaTypes.join(','));
  if (filters.state) params.set('state', filters.state);
  if (filters.transcodeDecisions?.length)
    params.set('transcodeDecisions', filters.transcodeDecisions.join(','));
  if (filters.platforms?.length) params.set('platforms', filters.platforms.join(','));
  if (filters.geoCountries?.length) params.set('countries', filters.geoCountries.join(','));
  if (filters.search) params.set('search', filters.search);
  if (filters.startDate) params.set('startDate', filters.startDate.toISOString());
  if (filters.endDate) params.set('endDate', filters.endDate.toISOString());
  if (!filters.startDate && !filters.endDate) params.set('period', 'all');
  if (filters.watched !== undefined) params.set('watched', String(filters.watched));
  if (filters.orderBy && filters.orderBy !== 'startedAt') params.set('orderBy', filters.orderBy);
  if (filters.orderDir && filters.orderDir !== 'desc') params.set('orderDir', filters.orderDir);

  return params;
}

export function History() {
  const { t } = useTranslation(['pages', 'common']);
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedServerIds, isMultiServer } = useServer();
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);

  // Deep-link: fetch session by ID from route param and auto-open sheet
  const { data: linkedSession } = useSession(sessionId ?? '');
  const hasOpenedLinkedSession = useRef(false);

  useEffect(() => {
    if (linkedSession && !hasOpenedLinkedSession.current) {
      hasOpenedLinkedSession.current = true;
      setSelectedSession(linkedSession);
    }
  }, [linkedSession]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(loadColumnVisibility);

  // Parse filters from URL on mount and when URL changes
  const filters = useMemo(() => {
    const parsed = parseFiltersFromUrl(searchParams);
    // Apply selected servers from context if not set in URL
    if (!parsed.serverIds?.length && selectedServerIds.length > 0) {
      parsed.serverIds = selectedServerIds;
    }
    return parsed;
  }, [searchParams, selectedServerIds]);

  // Query hooks
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useHistorySessions(filters);

  // Separate aggregates query - uses data filters only (excludes sorting)
  // This prevents aggregates from reloading when sorting changes
  const { orderBy: _orderBy, orderDir: _orderDir, ...dataFilters } = filters;
  const { data: aggregatesData, isLoading: aggregatesLoading } = useHistoryAggregates(dataFilters);

  const { data: filterOptions, isLoading: filterOptionsLoading } = useFilterOptions({
    serverIds: filters.serverIds,
    startDate: filters.startDate,
    endDate: filters.endDate,
  });

  // Flatten pages into single sessions array
  const sessions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) ?? [];
  }, [data]);

  // Use aggregates from dedicated query (doesn't reload on sort changes)
  const aggregates = aggregatesData;
  const total = aggregatesData?.playCount;

  // Handle filter changes - update URL
  const handleFiltersChange = useCallback(
    (newFilters: HistoryFilters) => {
      const params = filtersToUrlParams(newFilters);
      setSearchParams(params, { replace: true });
    },
    [setSearchParams]
  );

  // Handle column visibility changes - save to local storage
  const handleColumnVisibilityChange = useCallback((newVisibility: ColumnVisibility) => {
    setColumnVisibility(newVisibility);
    saveColumnVisibility(newVisibility);
  }, []);

  // Handle session click - open detail sheet
  const handleSessionClick = useCallback((session: SessionWithDetails) => {
    setSelectedSession(session);
  }, []);

  // Handle sort column change - toggle direction if same column, otherwise set new column
  const handleSortChange = useCallback(
    (column: SortableColumn) => {
      const currentOrderBy = filters.orderBy ?? 'startedAt';
      const currentOrderDir = filters.orderDir ?? 'desc';
      const newFilters = { ...filters };

      if (currentOrderBy === column) {
        // Toggle direction
        newFilters.orderDir = currentOrderDir === 'desc' ? 'asc' : 'desc';
      } else {
        // New column - default to descending
        newFilters.orderBy = column;
        newFilters.orderDir = 'desc';
      }
      handleFiltersChange(newFilters);
    },
    [filters, handleFiltersChange]
  );

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold">{t('pages:history.title')}</h1>
        <p className="text-muted-foreground">{t('pages:history.description')}</p>
      </div>

      {/* Aggregates Summary */}
      <HistoryAggregates aggregates={aggregates} total={total} isLoading={aggregatesLoading} />

      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <HistoryFiltersBar
            filters={filters}
            onFiltersChange={handleFiltersChange}
            filterOptions={filterOptions}
            isLoading={isLoading || filterOptionsLoading}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={handleColumnVisibilityChange}
            isMultiServer={isMultiServer}
          />
        </CardContent>
      </Card>

      {/* Sessions Table */}
      <Card>
        <CardContent className="p-0">
          <HistoryTable
            sessions={sessions}
            isLoading={isLoading}
            isFetchingNextPage={isFetchingNextPage}
            hasNextPage={hasNextPage}
            onLoadMore={() => void fetchNextPage()}
            onSessionClick={handleSessionClick}
            columnVisibility={columnVisibility}
            sortBy={filters.orderBy ?? 'startedAt'}
            sortDir={filters.orderDir ?? 'desc'}
            onSortChange={handleSortChange}
            isMultiServer={isMultiServer}
          />
        </CardContent>
      </Card>

      {/* Session Detail Sheet */}
      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSession(null);
            if (sessionId) void navigate('/history', { replace: true });
          }
        }}
      />
    </div>
  );
}
