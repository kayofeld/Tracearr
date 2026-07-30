/**
 * Settings page with sub-routes for different settings sections.
 * Components are organized in components/settings/ for maintainability.
 */
import { NavLink, Routes, Route } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

// Settings section components
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { ServerSettings } from '@/components/settings/ServerSettings';
import { AccessSettings } from '@/components/settings/AccessSettings';
import { MobileSettings } from '@/components/settings/MobileSettings';
import { TailscaleSettings } from '@/components/settings/TailscaleSettings';
import { ImportSettings } from '@/components/settings/ImportSettings';
import { OmbiSettings } from '@/components/settings/OmbiSettings';
import { SeerrSettings } from '@/components/settings/SeerrSettings';
import { JobsSettings } from '@/components/settings/JobsSettings';
import { PlayedStateSettings } from '@/components/settings/PlayedStateSettings';
import { BackupSettings } from '@/components/settings/BackupSettings';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import { NotificationAgentsManager } from '@/components/settings/notification-agents';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Bell } from 'lucide-react';

function SettingsNav() {
  const { t } = useTranslation('settings');

  const links = [
    { href: '/settings', label: t('tabs.general'), end: true },
    { href: '/settings/servers', label: t('tabs.servers') },
    { href: '/settings/notifications', label: t('tabs.notifications') },
    { href: '/settings/access', label: t('tabs.accessControl') },
    { href: '/settings/mobile', label: t('tabs.mobile') },
    { href: '/settings/tailscale', label: t('tabs.tailscale') },
    { href: '/settings/import', label: t('tabs.import') },
    { href: '/settings/ombi', label: t('tabs.ombi') },
    { href: '/settings/seerr', label: t('tabs.seerr') },
    { href: '/settings/jobs', label: t('tabs.jobs') },
    { href: '/settings/played-state', label: t('tabs.playedState') },
    { href: '/settings/backup', label: t('tabs.backup') },
    { href: '/settings/updates', label: t('tabs.updates') },
  ];

  return (
    <nav className="flex space-x-4 border-b pb-4">
      {links.map((link) => (
        <NavLink
          key={link.href}
          to={link.href}
          end={link.end}
          className={({ isActive }) =>
            cn(
              'text-sm font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground hover:text-primary'
            )
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

function NotificationSettings() {
  const { t } = useTranslation('pages');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          {t('settings.notifications.title')}
        </CardTitle>
        <CardDescription>{t('settings.notifications.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationAgentsManager />
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <SettingsNav />
      <Routes>
        <Route index element={<GeneralSettings />} />
        <Route path="servers" element={<ServerSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="access" element={<AccessSettings />} />
        <Route path="mobile" element={<MobileSettings />} />
        <Route path="tailscale" element={<TailscaleSettings />} />
        <Route path="import" element={<ImportSettings />} />
        <Route path="ombi" element={<OmbiSettings />} />
        <Route path="seerr" element={<SeerrSettings />} />
        <Route path="jobs" element={<JobsSettings />} />
        <Route path="played-state" element={<PlayedStateSettings />} />
        <Route path="backup" element={<BackupSettings />} />
        <Route path="updates" element={<UpdateSettings />} />
      </Routes>
    </div>
  );
}
