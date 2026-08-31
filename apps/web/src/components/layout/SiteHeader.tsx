import { useTranslation } from 'react-i18next';
import { Logo } from '@/components/brand/Logo';
import { SidebarTrigger } from '@/components/ui/sidebar';

/**
 * Mobile-only strip carrying the sidebar trigger; below md the rail never
 * renders and the sheet's own trigger sits inside the closed sheet.
 */
export function SiteHeader() {
  const { t } = useTranslation('nav');

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
      <SidebarTrigger className="-ml-1" aria-label={t('toggleSidebar')} />
      <Logo size="sm" />
    </header>
  );
}
