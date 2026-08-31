import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreateAutomationInput } from '@tracearr/shared';

const { dryRun } = vi.hoisted(() => ({ dryRun: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { automations: { dryRun } } }));

import { useDryRun } from './useDryRun';

function definition(name: string): CreateAutomationInput {
  return {
    name,
    kind: 'policy',
    severity: 'warning',
    triggers: [
      { id: '11111111-1111-4111-8111-111111111111', type: 'session.started', enabled: true },
    ],
    conditions: { groups: [] },
    actions: { actions: [] },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  dryRun.mockReset();
  dryRun.mockResolvedValue({ samples: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDryRun', () => {
  it('waits for the draft to settle before asking', async () => {
    renderHook(() => useDryRun(definition('Nightly'), { enabled: true }), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(dryRun).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(dryRun).toHaveBeenCalledTimes(1);
  });

  it('asks once, about the draft as it stands when the typing stops', async () => {
    const { rerender } = renderHook(
      ({ name }: { name: string }) => useDryRun(definition(name), { enabled: true }),
      { wrapper, initialProps: { name: 'One' } }
    );

    await act(() => vi.advanceTimersByTimeAsync(200));
    rerender({ name: 'Two' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    rerender({ name: 'Three' });
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(dryRun).toHaveBeenCalledWith({ definition: definition('Three') });
  });

  it('asks nothing while it is switched off, and drops what it last heard', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDryRun(definition('Nightly'), { enabled }),
      { wrapper, initialProps: { enabled: false } }
    );

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(dryRun).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(dryRun).toHaveBeenCalledTimes(1);
    // react-query batches its own notifications on a timer of its own.
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(result.current.data).toEqual({ samples: [] });

    rerender({ enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(result.current.data).toBeUndefined();
  });
});
