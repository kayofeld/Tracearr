import { lazy, Suspense, type ComponentType } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { NotFound } from '@/pages/NotFound';
import { Maintenance } from '@/pages/Maintenance';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';

// Auth/entry pages stay eager — they gate first paint and are small.
import { Login } from '@/pages/Login';
import { PlexCallback } from '@/pages/PlexCallback';
import { Setup } from '@/pages/Setup';

// Route pages are lazy-loaded so heavy deps (Highcharts, Leaflet, swagger-ui) land
// in their own chunks instead of the initial bundle. `named` adapts a named export
// to the default-export shape React.lazy expects.
const named =
  <M,>(loader: () => Promise<M>, key: keyof M) =>
  () =>
    loader().then((m) => ({ default: m[key] as ComponentType }));

const Dashboard = lazy(named(() => import('@/pages/Dashboard'), 'Dashboard'));
const Map = lazy(named(() => import('@/pages/Map'), 'Map'));
const StatsActivity = lazy(named(() => import('@/pages/stats/Activity'), 'StatsActivity'));
const StatsUsers = lazy(named(() => import('@/pages/stats/Users'), 'StatsUsers'));
const StatsDevices = lazy(named(() => import('@/pages/stats/Devices'), 'StatsDevices'));
const StatsBandwidth = lazy(named(() => import('@/pages/stats/Bandwidth'), 'StatsBandwidth'));
const LibraryOverview = lazy(named(() => import('@/pages/library/Overview'), 'LibraryOverview'));
const LibraryQuality = lazy(named(() => import('@/pages/library/Quality'), 'LibraryQuality'));
const LibraryStorage = lazy(named(() => import('@/pages/library/Storage'), 'LibraryStorage'));
const LibraryWatch = lazy(named(() => import('@/pages/library/Watch'), 'LibraryWatch'));
const Users = lazy(named(() => import('@/pages/Users'), 'Users'));
const UserDetail = lazy(named(() => import('@/pages/UserDetail'), 'UserDetail'));
const Rules = lazy(named(() => import('@/pages/Rules'), 'Rules'));
const Violations = lazy(named(() => import('@/pages/Violations'), 'Violations'));
const ViolationDetail = lazy(named(() => import('@/pages/ViolationDetail'), 'ViolationDetail'));
const History = lazy(named(() => import('@/pages/History'), 'History'));
const Settings = lazy(named(() => import('@/pages/Settings'), 'Settings'));
const Debug = lazy(named(() => import('@/pages/Debug'), 'Debug'));
const ApiDocs = lazy(named(() => import('@/pages/ApiDocs'), 'ApiDocs'));

const RouteFallback = (
  <div className="flex h-full items-center justify-center">
    <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
  </div>
);

export function App() {
  // Automatically update document title based on current route
  useDocumentTitle();
  const { isInMaintenance } = useMaintenanceMode();

  if (isInMaintenance) {
    return <Maintenance />;
  }

  return (
    <>
      <Suspense fallback={RouteFallback}>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/auth/plex-callback" element={<PlexCallback />} />
          <Route path="/setup" element={<Setup />} />

          {/* Protected routes */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="map" element={<Map />} />

            {/* Stats routes */}
            <Route path="stats" element={<Navigate to="/stats/activity" replace />} />
            <Route path="stats/activity" element={<StatsActivity />} />
            <Route path="stats/library" element={<Navigate to="/library" replace />} />
            <Route path="stats/users" element={<StatsUsers />} />

            {/* Performance routes */}
            <Route path="stats/devices" element={<StatsDevices />} />
            <Route path="stats/bandwidth" element={<StatsBandwidth />} />

            {/* Library routes */}
            <Route path="library" element={<LibraryOverview />} />
            <Route path="library/quality" element={<LibraryQuality />} />
            <Route path="library/storage" element={<LibraryStorage />} />
            <Route path="library/watch" element={<LibraryWatch />} />

            {/* Other routes */}
            <Route path="history/:sessionId?" element={<History />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:id" element={<UserDetail />} />
            <Route path="rules" element={<Rules />} />
            <Route path="violations" element={<Violations />} />
            <Route path="violations/:id" element={<ViolationDetail />} />
            <Route path="settings/*" element={<Settings />} />
            <Route path="api-docs" element={<ApiDocs />} />

            {/* Hidden debug page (owner only) */}
            <Route path="debug" element={<Debug />} />

            {/* Legacy redirects */}
            <Route path="analytics" element={<Navigate to="/stats/activity" replace />} />
            <Route path="activity" element={<Navigate to="/stats/activity" replace />} />

            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
