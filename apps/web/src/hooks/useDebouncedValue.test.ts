import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('holds the previous value until the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'ab' });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('ab');
  });

  it('restarts the window on each edit and settles once', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const { rerender } = renderHook(({ value }) => useDebouncedValue(value, 300, onSettle), {
      initialProps: { value: '' },
    });

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'bo' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'bob' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('bob');
  });

  it('never settles the initial value', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();

    renderHook(() => useDebouncedValue('bob', 300, onSettle));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onSettle).not.toHaveBeenCalled();
  });

  it('settles nothing when the value returns to the settled one inside the window', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300, onSettle),
      {
        initialProps: { value: 'bob' },
      }
    );

    rerender({ value: 'bobb' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: 'bob' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onSettle).not.toHaveBeenCalled();
    expect(result.current).toBe('bob');
  });

  it('fires the newest callback without restarting the timer when it changes identity', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { rerender } = renderHook(
      ({ value, tag }: { value: string; tag: string }) =>
        useDebouncedValue(value, 300, (settled) => calls.push(`${tag}:${settled}`)),
      { initialProps: { value: 'a', tag: 'first' } }
    );

    rerender({ value: 'ab', tag: 'first' });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // An unrelated re-render mid-flight: a fresh closure, same pending edit.
    rerender({ value: 'ab', tag: 'second' });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(calls).toEqual(['second:ab']);
  });

  it('drops a pending settle when the hook unmounts', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 300, onSettle),
      { initialProps: { value: 'a' } }
    );

    rerender({ value: 'ab' });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onSettle).not.toHaveBeenCalled();
  });
});
