import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, createRoutesFromElements, RouterProvider } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Highcharts touches CSS.supports at import time, which jsdom does not implement.
vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts/highcharts-more', () => ({ default: () => undefined }));
vi.mock('highcharts-react-official', () => ({ HighchartsReact: () => null }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/hooks/queries/useAutomations', () => ({
  useAutomation: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/components/automations/builder', () => ({
  AutomationBuilder: () => <h1>automation builder</h1>,
}));

vi.mock('@/pages/Dashboard', () => ({
  Dashboard: () => <h1>dashboard</h1>,
}));

vi.mock('@/components/layout/Layout', async () => {
  const { Outlet } = await import('react-router');
  return { Layout: () => <Outlet /> };
});

import { appRoutes } from './App';

function renderAt(url: string) {
  const router = createMemoryRouter(createRoutesFromElements(appRoutes), {
    initialEntries: [url],
  });
  return render(<RouterProvider router={router} />);
}

describe('App routes', () => {
  // Route pages are lazy-loaded (code splitting), so the first paint is the
  // Suspense fallback and the assertions have to wait for the chunk.
  it('renders the builder page for a new automation', async () => {
    renderAt('/automations/new');

    expect(await screen.findByRole('heading', { name: 'automation builder' })).toBeInTheDocument();
  });

  it('still resolves the routes that were there before', async () => {
    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'dashboard' })).toBeInTheDocument();
  });

  it('renders the builder page for an existing automation', async () => {
    renderAt('/automations/7fd0f2e1/edit');

    expect(await screen.findByRole('heading', { name: 'automation builder' })).toBeInTheDocument();
  });
});
