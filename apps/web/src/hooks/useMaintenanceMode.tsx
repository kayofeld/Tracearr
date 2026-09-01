import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { onlineManager } from '@tanstack/react-query';
import type { RestoreProgress } from '@tracearr/shared';
import { BASE_PATH } from '@/lib/basePath';

type InitStep = 'migrations' | 'timescale' | 'services';

interface HealthResponse {
  mode?: string;
  wasReady?: boolean;
  db?: boolean;
  redis?: boolean;
  restore?: RestoreProgress;
  initStep?: InitStep | null;
}

interface MaintenanceState {
  /** The server said so: mode maintenance/starting, a restore, or an API 503 */
  isInMaintenance: boolean;
  /** We couldn't get a real answer from /health several times in a row */
  isUnreachable: boolean;
  /** True if the app was previously in ready mode before entering maintenance */
  wasReady: boolean;
  db: boolean;
  redis: boolean;
  /** Present when a database restore is in progress */
  restore: RestoreProgress | null;
  /** Startup phase currently applying; migrations and timescale phases must
   * not be interrupted by a restart */
  initStep: InitStep | null;
}

const FAST_POLL_MS = 5000;
const NORMAL_POLL_MS = 60000;
const PROBE_TIMEOUT_MS = 5000;
// One bad probe is a proxy hiccup as often as an outage; three in a row is a pattern
const UNREACHABLE_AFTER = 3;
const MAINTENANCE_EVENT = 'tracearr:maintenance-mode';

const MaintenanceContext = createContext<MaintenanceState>({
  isInMaintenance: false,
  isUnreachable: false,
  wasReady: false,
  db: true,
  redis: true,
  restore: null,
  initStep: null,
});

async function probeHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_PATH}/health`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  // A proxy error page arrives as a 502 with an HTML body; only JSON from us counts
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`health probe returned ${res.status}`);
  }
  return (await res.json()) as HealthResponse;
}

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<MaintenanceState, 'isUnreachable'>>({
    isInMaintenance: false,
    wasReady: false,
    db: true,
    redis: true,
    restore: null,
    initStep: null,
  });
  const [failures, setFailures] = useState(0);
  const sawRestoreRef = useRef(false);

  const checkHealth = useCallback(async () => {
    let data: HealthResponse;
    try {
      data = await probeHealth();
    } catch {
      // Pause queries rather than let them error out while we wait to find out
      // whether this is a blip or an outage
      onlineManager.setOnline(false);
      setFailures((n) => n + 1);
      return;
    }

    setFailures(0);

    const inMaintenance = data.mode === 'maintenance' || data.mode === 'starting';
    // Every API call 503s during maintenance, so there's nothing worth resuming yet
    if (!inMaintenance) onlineManager.setOnline(true);

    if (data.restore && data.restore.phase !== 'failed') {
      sawRestoreRef.current = true;
    }

    // After a restore completes and server is ready, force a full reload
    // so the user lands on the login page (sessions were purged)
    if (sawRestoreRef.current && !inMaintenance) {
      sawRestoreRef.current = false;
      window.location.reload();
      return;
    }

    setState({
      isInMaintenance: inMaintenance,
      wasReady: data.wasReady === true || !inMaintenance,
      db: data.db ?? false,
      redis: data.redis ?? false,
      restore: data.restore ?? null,
      initStep: data.initStep ?? null,
    });
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const pollFast = state.isInMaintenance || failures > 0;
  useEffect(() => {
    const interval = setInterval(
      () => {
        if (document.visibilityState === 'hidden') return;
        void checkHealth();
      },
      pollFast ? FAST_POLL_MS : NORMAL_POLL_MS
    );
    return () => clearInterval(interval);
  }, [pollFast, checkHealth]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkHealth();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [checkHealth]);

  // The API client fires this on a 503 that carries the maintenance flag
  useEffect(() => {
    const handler = () => {
      setState((prev) => ({ ...prev, isInMaintenance: true }));
      void checkHealth();
    };
    globalThis.addEventListener(MAINTENANCE_EVENT, handler);
    return () => globalThis.removeEventListener(MAINTENANCE_EVENT, handler);
  }, [checkHealth]);

  const isUnreachable = failures >= UNREACHABLE_AFTER;
  // The last payload came from a process we can no longer reach: don't keep
  // showing its restore phase, green service dots, or "do not restart"
  const value = useMemo(
    () =>
      isUnreachable
        ? { ...state, isUnreachable, db: false, redis: false, restore: null, initStep: null }
        : { ...state, isUnreachable },
    [state, isUnreachable]
  );

  return <MaintenanceContext.Provider value={value}>{children}</MaintenanceContext.Provider>;
}

export function useMaintenanceMode(): MaintenanceState {
  return useContext(MaintenanceContext);
}

export { MAINTENANCE_EVENT };
