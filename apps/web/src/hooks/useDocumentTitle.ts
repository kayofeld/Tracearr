import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { navigation } from '@/components/layout/nav-data';
import type { NavKey } from '@tracearr/translations';

const APP_NAME = 'Tracearr';

/**
 * Build a flat map of href -> nameKey from navigation data
 */
function buildRouteMap(): Map<string, NavKey> {
  return new Map(
    navigation.flatMap((section) => section.items.map((item) => [item.href, item.nameKey] as const))
  );
}

const routeMap = buildRouteMap();

/** What a page called itself, by path, so the route derivation defers to it. */
const pageTitles = new Map<string, string>();

/**
 * Hook to automatically update the document title based on the current route.
 * Titles are derived from nav-data.ts for consistency.
 */
export function useDocumentTitle() {
  const location = useLocation();
  const { t } = useTranslation(['nav', 'pages']);

  useEffect(() => {
    const pathname = location.pathname;

    // A page that knows its own name has already said so, whether or not its effect ran first.
    const own = pageTitles.get(pathname);
    if (own !== undefined) {
      document.title = `${own} | ${APP_NAME}`;
      return;
    }

    // Check for exact match in navigation
    const navKey = routeMap.get(pathname);
    if (navKey) {
      document.title = `${t(navKey)} | ${APP_NAME}`;
      return;
    }

    // Handle dynamic routes and routes not in nav
    if (pathname.startsWith('/users/')) {
      document.title = `${t('pages:userDetail.title')} | ${APP_NAME}`;
      return;
    }

    if (pathname.startsWith('/media/')) {
      document.title = `${t('pages:media.detail.title')} | ${APP_NAME}`;
      return;
    }

    if (pathname === '/automations/new') {
      document.title = `${t('pages:automations.createAutomation')} | ${APP_NAME}`;
      return;
    }

    if (pathname.startsWith('/automations/') && pathname.endsWith('/edit')) {
      document.title = `${t('pages:automations.editAutomation')} | ${APP_NAME}`;
      return;
    }

    // The row's own name lands via usePageTitle once it loads; this holds the tab until then.
    if (pathname.startsWith('/automations/')) {
      document.title = `${t('pages:automations.detail.title')} | ${APP_NAME}`;
      return;
    }

    if (pathname.startsWith('/settings')) {
      document.title = `${t('settings')} | ${APP_NAME}`;
      return;
    }

    // Fallback: derive title from pathname
    const segments = pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment) {
      const title = lastSegment
        .split('-')
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      document.title = `${title} | ${APP_NAME}`;
      return;
    }

    document.title = APP_NAME;
  }, [location.pathname, t]);
}

/**
 * A page that knows its own name says so, over whatever the route derived. The
 * previous title comes back on unmount, so a route with nothing to say is unaffected.
 */
export function usePageTitle(title: string | undefined) {
  const { pathname } = useLocation();

  useEffect(() => {
    if (title === undefined || title === '') return;
    const previous = document.title;
    pageTitles.set(pathname, title);
    document.title = `${title} | ${APP_NAME}`;
    return () => {
      pageTitles.delete(pathname);
      document.title = previous;
    };
  }, [pathname, title]);
}
