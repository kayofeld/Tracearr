import { useQueries, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';

export interface MultiServerQueryResult<T> {
  byServer: Map<string, UseQueryResult<T>>;
  isLoading: boolean;
  error: unknown;
}

export function useMultiServerQuery<T>(
  serverIds: string[],
  queryFactory: (serverId: string) => UseQueryOptions<T>
): MultiServerQueryResult<T> {
  const results = useQueries({
    queries: serverIds.map((id) => queryFactory(id)),
  }) as UseQueryResult<T>[];

  const byServer = new Map<string, UseQueryResult<T>>();
  serverIds.forEach((id, i) => {
    const r = results[i];
    if (r) byServer.set(id, r);
  });

  const isLoading = results.some((r) => r.isFetching);
  const error = results.find((r) => r.error)?.error;

  return { byServer, isLoading, error };
}
