import {
  LayoutDashboard,
  Map,
  History,
  BarChart3,
  Users,
  Shield,
  AlertTriangle,
  Settings,
  TrendingUp,
  UserCircle,
  Gauge,
  Smartphone,
  Activity,
  BookOpen,
  Sparkles,
  HardDrive,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { NavKey } from '@tracearr/translations';

export interface NavItem {
  nameKey: NavKey;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface NavGroup {
  nameKey: NavKey;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

export const navigation: NavEntry[] = [
  { nameKey: 'dashboard', href: '/', icon: LayoutDashboard },
  { nameKey: 'map', href: '/map', icon: Map },
  { nameKey: 'history', href: '/history', icon: History },
  {
    nameKey: 'stats',
    icon: BarChart3,
    children: [
      { nameKey: 'activity', href: '/stats/activity', icon: TrendingUp },
      { nameKey: 'users', href: '/stats/users', icon: UserCircle },
    ],
  },
  {
    nameKey: 'library',
    icon: BookOpen,
    children: [
      { nameKey: 'overview', href: '/library', icon: LayoutDashboard },
      { nameKey: 'quality', href: '/library/quality', icon: Sparkles },
      { nameKey: 'storage', href: '/library/storage', icon: HardDrive },
      { nameKey: 'watch', href: '/library/watch', icon: Eye },
      { nameKey: 'neverWatched', href: '/library/never-watched', icon: EyeOff },
    ],
  },
  {
    nameKey: 'performance',
    icon: Gauge,
    children: [
      { nameKey: 'devices', href: '/stats/devices', icon: Smartphone },
      { nameKey: 'bandwidth', href: '/stats/bandwidth', icon: Activity },
    ],
  },
  { nameKey: 'users', href: '/users', icon: Users },
  { nameKey: 'rules', href: '/rules', icon: Shield },
  { nameKey: 'violations', href: '/violations', icon: AlertTriangle },
  { nameKey: 'settings', href: '/settings', icon: Settings },
];
