import { useEffect, useRef, useState } from 'react';

/**
 * Debounces a value and, optionally, fires `onSettle` when it lands.
 *
 * `onSettle` is held in a ref, so a caller that rebuilds the callback on every
 * render (the usual shape: a closure over the current filter object) neither
 * restarts the timer nor commits a stale closure when it fires. That is the
 * `filtersRef` fix from CatalogToolbar generalised.
 *
 * The initial value never settles, and a value that returns to the last
 * settled one inside the window settles nothing.
 */
export function useDebouncedValue<T>(value: T, delay: number, onSettle?: (value: T) => void): T {
  const [debounced, setDebounced] = useState(value);
  const settledRef = useRef(value);
  const onSettleRef = useRef(onSettle);

  useEffect(() => {
    onSettleRef.current = onSettle;
  });

  useEffect(() => {
    if (Object.is(value, settledRef.current)) return;

    const handle = setTimeout(() => {
      settledRef.current = value;
      setDebounced(value);
      onSettleRef.current?.(value);
    }, delay);

    return () => clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}
