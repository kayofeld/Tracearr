import { describe, it, expect } from 'vitest';
import { isNavItemActive, navigation, type NavItem } from './nav-data';

const allItems: NavItem[] = navigation.flatMap((section) => section.items);

function byHref(href: string): NavItem {
  const found = allItems.find((item) => item.href === href);
  if (!found) throw new Error(`no nav item for ${href}`);
  return found;
}

function activeHrefs(pathname: string): string[] {
  return allItems.filter((item) => isNavItemActive(pathname, item)).map((item) => item.href);
}

describe('navigation shape', () => {
  it('exposes every destination exactly once', () => {
    const hrefs = allItems.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives each destination a distinct icon so an icon rail stays decodable', () => {
    const icons = allItems.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('gives each destination a distinct label key', () => {
    const keys = allItems.map((item) => item.nameKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('isNavItemActive', () => {
  it('matches the dashboard only on an exact root path', () => {
    const dashboard = byHref('/');
    expect(isNavItemActive('/', dashboard)).toBe(true);
    expect(isNavItemActive('/users', dashboard)).toBe(false);
  });

  it('matches an entry and its descendants', () => {
    const users = byHref('/users');
    expect(isNavItemActive('/users', users)).toBe(true);
    expect(isNavItemActive('/users/abc', users)).toBe(true);
    expect(isNavItemActive('/users-report', users)).toBe(false);
  });

  it('keeps /media off while a deeper /media route is open', () => {
    expect(activeHrefs('/media')).toEqual(['/media']);
    expect(activeHrefs('/media/browse')).toEqual(['/media/browse']);
    expect(activeHrefs('/media/genres')).toEqual(['/media/genres']);
  });

  it('matches descendants of an entry nothing sits below', () => {
    expect(activeHrefs('/media/browse/123')).toEqual(['/media/browse']);
  });

  it('never lights up two destinations at once', () => {
    const paths = [
      '/',
      '/map',
      '/history',
      '/stats/activity',
      '/stats/users',
      '/stats/devices',
      '/stats/bandwidth',
      '/media',
      '/media/browse',
      '/media/genres',
      '/library/quality',
      '/library/storage',
      '/library/watch',
      '/users',
      '/automations',
      '/violations',
      '/settings',
    ];

    for (const path of paths) {
      expect(activeHrefs(path), `${path} should mark exactly one entry`).toHaveLength(1);
    }
  });

  it('separates the two user destinations', () => {
    expect(activeHrefs('/stats/users')).toEqual(['/stats/users']);
    expect(activeHrefs('/users')).toEqual(['/users']);
  });
});
