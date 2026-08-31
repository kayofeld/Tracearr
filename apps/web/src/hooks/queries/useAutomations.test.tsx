import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Automation, ListResponse } from '@tracearr/shared';

vi.mock('@/lib/api', () => ({
  api: {
    automations: {
      list: vi.fn(),
      update: vi.fn(),
      bulkUpdate: vi.fn(),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { api } from '@/lib/api';
import { AUTOMATIONS_KEY, useAutomations, useToggleAutomation } from './useAutomations';

const mockList = vi.mocked(api.automations.list);
const mockUpdate = vi.mocked(api.automations.update);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function automation(id: string, isActive: boolean): Automation {
  return {
    id,
    name: `Automation ${id}`,
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [],
    conditions: { groups: [] },
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef: null,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function page(rows: Automation[]): ListResponse<Automation> {
  return { data: rows, meta: { page: 1, pageSize: 20, total: rows.length } };
}

describe('useAutomations', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('passes the filter params through to the list endpoint', async () => {
    mockList.mockResolvedValue(page([]));

    const { result } = renderHook(() => useAutomations({ kind: 'notification', enabled: false }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockList).toHaveBeenCalledWith({ kind: 'notification', enabled: false });
  });

  it('keys each param set separately, so a filter change refetches', async () => {
    mockList.mockResolvedValue(page([]));

    const { rerender } = renderHook((props: { kind?: 'policy' }) => useAutomations(props), {
      wrapper: wrapper(client),
      initialProps: {},
    });

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    rerender({ kind: 'policy' });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });
});

describe('useToggleAutomation', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('flips the cached row before the request resolves', async () => {
    const key = [...AUTOMATIONS_KEY, 'list', {}];
    client.setQueryData(key, page([automation('a-1', true)]));
    let resolve = (): void => undefined;
    mockUpdate.mockImplementation(
      () => new Promise((r) => (resolve = () => r(automation('a-1', false))))
    );

    const { result } = renderHook(() => useToggleAutomation(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ id: 'a-1', isActive: false });
    });

    await waitFor(() => {
      expect(client.getQueryData<ListResponse<Automation>>(key)?.data[0]?.isActive).toBe(false);
    });

    act(() => {
      resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('puts the cached row back when the request fails', async () => {
    const key = [...AUTOMATIONS_KEY, 'list', {}];
    client.setQueryData(key, page([automation('a-1', true)]));
    mockUpdate.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useToggleAutomation(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ id: 'a-1', isActive: false });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<ListResponse<Automation>>(key)?.data[0]?.isActive).toBe(true);
  });
});
