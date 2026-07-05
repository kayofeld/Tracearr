import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { AuthProvider } from '@/hooks/useAuth';
import { ServerProvider } from '@/hooks/useServer';
import { SocketProvider } from '@/hooks/useSocket';
import { MaintenanceProvider } from '@/hooks/useMaintenanceMode';
import { ThemeProvider } from '@/components/theme-provider';
import { BASE_URL } from '@/lib/basePath';
import { sweepLegacyTokens } from '@/lib/legacyTokenSweep';
import { App } from './App';
import { i18nReady } from './i18n';
import './styles/globals.css';

// Run before anything else can read stale localStorage tokens from pre-cookie-session builds.
sweepLegacyTokens();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      // Retry failed queries with exponential backoff
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      // Auto-refetch when reconnecting or window regains focus
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

// Wait for i18n to load the active locale before first paint
void i18nReady.then(() => {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark" storageKey="tracearr-theme">
        <QueryClientProvider client={queryClient}>
          <BrowserRouter basename={BASE_URL}>
            <MaintenanceProvider>
              <AuthProvider>
                <ServerProvider>
                  <SocketProvider>
                    <App />
                  </SocketProvider>
                </ServerProvider>
              </AuthProvider>
            </MaintenanceProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>
  );
});
