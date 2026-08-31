import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Settings } from './Settings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/settings/GeneralSettings', () => ({ GeneralSettings: () => null }));
vi.mock('@/components/settings/ServerSettings', () => ({ ServerSettings: () => null }));
vi.mock('@/components/settings/AccessSettings', () => ({ AccessSettings: () => null }));
vi.mock('@/components/settings/MobileSettings', () => ({ MobileSettings: () => null }));
vi.mock('@/components/settings/TailscaleSettings', () => ({ TailscaleSettings: () => null }));
vi.mock('@/components/settings/ImportSettings', () => ({ ImportSettings: () => null }));
vi.mock('@/components/settings/JobsSettings', () => ({ JobsSettings: () => null }));
vi.mock('@/components/settings/BackupSettings', () => ({ BackupSettings: () => null }));
vi.mock('@/components/settings/destinations', () => ({
  DestinationsManager: () => <div>destinations manager</div>,
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

import { useAuth } from '@/hooks/useAuth';

function renderNotifications(role: string) {
  vi.mocked(useAuth).mockReturnValue({
    user: { role },
  } as unknown as ReturnType<typeof useAuth>);
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <Settings />
    </MemoryRouter>
  );
}

describe('Settings notifications tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the owner the destinations manager', () => {
    renderNotifications('owner');

    expect(screen.getByText('destinations manager')).toBeInTheDocument();
  });

  it('tells an admin the list is owner-only instead of showing an empty manager', () => {
    renderNotifications('admin');

    expect(screen.queryByText('destinations manager')).not.toBeInTheDocument();
    expect(screen.getByText('settings.destinations.ownerOnly')).toBeInTheDocument();
  });
});
