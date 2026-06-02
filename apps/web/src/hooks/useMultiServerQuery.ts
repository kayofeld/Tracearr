import { useQueries, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';

export interface MultiServerQueryResult<T> {
  byServer: Map<string, UseQueryResult<T>>;
  /** Any server still in its initial load (no cached data yet). */
  isLoading: boolean;
  /** Any server fetching, including background refetches over existing data. */
  isFetching: boolean;
  error: unknown;
}

export function useMultiServerQuery<T>(
  serverIds: string[],
  queryFactory: (serverId: string) => UseQueryOptions<T>
): MultiServerQueryResult<T> {
  const results = useQueries({
    queries: serverIds.map((id) => queryFactory(id)),
  });

  const byServer = new Map<string, UseQueryResult<T>>();
  serverIds.forEach((id, i) => {
    const r = results[i];
    if (r) byServer.set(id, r);
  });

  const isLoading = results.some((r) => r.isLoading);
  const isFetching = results.some((r) => r.isFetching);
  const error = results.find((r) => r.error)?.error;

  return { byServer, isLoading, isFetching, error };
}
