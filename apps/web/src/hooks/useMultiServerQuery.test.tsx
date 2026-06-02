import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMultiServerQuery } from './useMultiServerQuery';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useMultiServerQuery', () => {
  it('runs one query per serverId and returns results keyed by serverId', async () => {
    const { result } = renderHook(
      () =>
        useMultiServerQuery(['a', 'b'], (id) => ({
          queryKey: ['thing', id],
          queryFn: () => Promise.resolve(`payload-${id}`),
        })),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.byServer.get('a')?.data).toBe('payload-a');
    expect(result.current.byServer.get('b')?.data).toBe('payload-b');
  });

  it('reports isLoading and isFetching while any per-server query is in its initial load', async () => {
    let resolveA: (v: string) => void = () => undefined;
    const promiseA = new Promise<string>((r) => {
      resolveA = r;
    });

    const { result } = renderHook(
      () =>
        useMultiServerQuery(['a', 'b'], (id) =>
          id === 'a'
            ? { queryKey: ['t', 'a'], queryFn: () => promiseA }
            : { queryKey: ['t', 'b'], queryFn: () => Promise.resolve('b') }
        ),
      { wrapper: wrapper() }
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isFetching).toBe(true);
    resolveA('a');
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isFetching).toBe(false);
  });

  it('returns an empty byServer map when serverIds is empty', () => {
    const { result } = renderHook(
      () => useMultiServerQuery([], () => ({ queryKey: ['t'], queryFn: () => Promise.resolve(1) })),
      { wrapper: wrapper() }
    );
    expect(result.current.byServer.size).toBe(0);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
  });

  it('reports isLoading and isFetching false when all queries are disabled', () => {
    const { result } = renderHook(
      () =>
        useMultiServerQuery(['a'], (id) => ({
          queryKey: ['t', id],
          queryFn: () => Promise.resolve(id),
          enabled: false,
        })),
      { wrapper: wrapper() }
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
  });

  it('surfaces a rejected query as the error and exposes the per-server error', async () => {
    const oops = new Error('oops');
    const { result } = renderHook(
      () =>
        useMultiServerQuery(['a', 'b'], (id) => ({
          queryKey: ['t', id],
          queryFn: () => (id === 'a' ? Promise.reject(oops) : Promise.resolve('b')),
        })),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(oops);
    expect(result.current.byServer.get('a')?.error).toBe(oops);
    expect(result.current.byServer.get('b')?.data).toBe('b');
  });
});
