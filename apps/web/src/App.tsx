import { lazy, Suspense, type ComponentType } from 'react';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from 'react-router';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { RouteError } from '@/components/RouteError';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { BASE_URL } from '@/lib/basePath';
import { Login } from '@/pages/Login';
import { PlexCallback } from '@/pages/PlexCallback';
import { Setup } from '@/pages/Setup';
import { NotFound } from '@/pages/NotFound';
import { Maintenance } from '@/pages/Maintenance';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';

// Route pages are lazy-loaded so heavy deps (Highcharts, maplibre, swagger-ui)
// land in their own chunks instead of the initial bundle. `named` adapts a named
// export to the default-export shape React.lazy expects.
const named =
  <M,>(loader: () => Promise<M>, key: keyof M) =>
  () =>
    loader().then((m) => ({ default: m[key] as ComponentType }));

const Dashboard = lazy(named(() => import('@/pages/Dashboard'), 'Dashboard'));
const Map = lazy(named(() => import('@/pages/Map'), 'Map'));
const StatsActivity = lazy(named(() => import('@/pages/stats/Activity'), 'StatsActivity'));
const StatsUsers = lazy(named(() => import('@/pages/stats/Users'), 'StatsUsers'));
const StatsRequesters = lazy(named(() => import('@/pages/stats/Requesters'), 'StatsRequesters'));
const StatsDevices = lazy(named(() => import('@/pages/stats/Devices'), 'StatsDevices'));
const StatsBandwidth = lazy(named(() => import('@/pages/stats/Bandwidth'), 'StatsBandwidth'));
const LibraryQuality = lazy(named(() => import('@/pages/library/Quality'), 'LibraryQuality'));
const LibraryStorage = lazy(named(() => import('@/pages/library/Storage'), 'LibraryStorage'));
const LibraryWatch = lazy(named(() => import('@/pages/library/Watch'), 'LibraryWatch'));
const LibraryNeverWatched = lazy(
  named(() => import('@/pages/library/NeverWatched'), 'LibraryNeverWatched')
);
const MediaOverview = lazy(named(() => import('@/pages/media/Overview'), 'MediaOverview'));
const MediaGrid = lazy(named(() => import('@/pages/media/Grid'), 'MediaGrid'));
const MediaGenres = lazy(named(() => import('@/pages/media/Genres'), 'MediaGenres'));
const MediaDetail = lazy(named(() => import('@/pages/media/Detail'), 'MediaDetail'));
const Users = lazy(named(() => import('@/pages/Users'), 'Users'));
const UserDetail = lazy(named(() => import('@/pages/UserDetail'), 'UserDetail'));
const Automations = lazy(named(() => import('@/pages/Automations'), 'Automations'));
const AutomationBuilderPage = lazy(
  named(() => import('@/pages/AutomationBuilderPage'), 'AutomationBuilderPage')
);
const AutomationDetail = lazy(named(() => import('@/pages/AutomationDetail'), 'AutomationDetail'));
const Violations = lazy(named(() => import('@/pages/Violations'), 'Violations'));
const ViolationDetail = lazy(named(() => import('@/pages/ViolationDetail'), 'ViolationDetail'));
const History = lazy(named(() => import('@/pages/History'), 'History'));
const Settings = lazy(named(() => import('@/pages/Settings'), 'Settings'));
const Debug = lazy(named(() => import('@/pages/Debug'), 'Debug'));
const ApiDocs = lazy(named(() => import('@/pages/ApiDocs'), 'ApiDocs'));

// useDocumentTitle reads the location, so the shell that calls it has to sit inside
// the router rather than above RouterProvider.
function RootLayout() {
  useDocumentTitle();

  return (
    <>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
          </div>
        }
      >
        <Outlet />
      </Suspense>
      <Toaster />
    </>
  );
}

export const appRoutes = (
  <Route element={<RootLayout />} errorElement={<RouteError />}>
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
      <Route errorElement={<RouteError />}>
        <Route index element={<Dashboard />} />
        <Route path="map" element={<Map />} />

        {/* Stats routes */}
        <Route path="stats" element={<Navigate to="/stats/activity" replace />} />
        <Route path="stats/activity" element={<StatsActivity />} />
        <Route path="stats/library" element={<Navigate to="/media" replace />} />
        <Route path="stats/users" element={<StatsUsers />} />
        <Route path="stats/requesters" element={<StatsRequesters />} />

        {/* Performance routes */}
        <Route path="stats/devices" element={<StatsDevices />} />
        <Route path="stats/bandwidth" element={<StatsBandwidth />} />

        {/* Library routes - overview merged into Media, other pages untouched */}
        <Route path="library" element={<Navigate to="/media" replace />} />
        <Route path="library/quality" element={<LibraryQuality />} />
        <Route path="library/storage" element={<LibraryStorage />} />
        <Route path="library/watch" element={<LibraryWatch />} />
        <Route path="library/never-watched" element={<LibraryNeverWatched />} />

        {/* Media routes */}
        <Route path="media" element={<MediaOverview />} />
        <Route path="media/browse" element={<MediaGrid />} />
        <Route path="media/movies" element={<Navigate to="/media/browse" replace />} />
        <Route path="media/shows" element={<Navigate to="/media/browse?type=shows" replace />} />
        <Route path="media/genres" element={<MediaGenres />} />
        <Route path="media/:id" element={<MediaDetail />} />

        {/* Other routes */}
        <Route path="history/:sessionId?" element={<History />} />
        <Route path="users" element={<Users />} />
        <Route path="users/:id" element={<UserDetail />} />
        <Route path="automations" element={<Automations />} />
        <Route path="automations/new" element={<AutomationBuilderPage />} />
        <Route path="automations/:id" element={<AutomationDetail />} />
        <Route path="automations/:id/edit" element={<AutomationBuilderPage />} />
        <Route path="violations" element={<Violations />} />
        <Route path="violations/:id" element={<ViolationDetail />} />
        <Route path="settings/*" element={<Settings />} />
        <Route
          path="api-docs"
          element={
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                </div>
              }
            >
              <ApiDocs />
            </Suspense>
          }
        />

        {/* Hidden debug page (owner only) */}
        <Route path="debug" element={<Debug />} />

        {/* Legacy redirects */}
        <Route path="analytics" element={<Navigate to="/stats/activity" replace />} />
        <Route path="activity" element={<Navigate to="/stats/activity" replace />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Route>
  </Route>
);

const router = createBrowserRouter(createRoutesFromElements(appRoutes), { basename: BASE_URL });

export function App() {
  const { isInMaintenance } = useMaintenanceMode();

  if (isInMaintenance) {
    return <Maintenance />;
  }

  return <RouterProvider router={router} />;
}
