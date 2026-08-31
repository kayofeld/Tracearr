/** The timer pair a leader-only checker runs on: one delayed first pass, then a fixed interval. */
export interface PeriodicTimers {
  stop: () => void;
}

export function startPeriodic(
  initialDelayMs: number,
  intervalMs: number,
  run: () => Promise<void>
): PeriodicTimers {
  const initial = setTimeout(() => void run(), initialDelayMs);
  const interval = setInterval(() => void run(), intervalMs);
  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
