import { fetchJson } from '../utils/http.js';
import { maxVersion, compareVersions } from '../utils/pluginVersion.js';
import { sseManager } from '../services/sseManager.js';
import { getSettings } from '../services/settings.js';
import { enqueueNotification } from './notificationQueue.js';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';

const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Tracearr/Media-Server-SSE/main/manifest.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;
const RELEASES_URL = 'https://github.com/Tracearr/Media-Server-SSE/releases/latest';

interface ManifestEntry {
  versions?: { version?: string }[];
}

let checkTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
// serverId -> latest version already nudged for; re-arms when latest changes
const nudgedVersions = new Map<string, string>();

export function _resetNudgeStateForTests(): void {
  nudgedVersions.clear();
}

export async function runPluginUpdateCheck(): Promise<void> {
  try {
    const settings = await getSettings(['pluginUpdateCheckEnabled', 'pluginManifestUrl']);
    if (!settings.pluginUpdateCheckEnabled) return;

    const url = settings.pluginManifestUrl ?? DEFAULT_MANIFEST_URL;
    let manifest: ManifestEntry[];
    try {
      manifest = await fetchJson<ManifestEntry[]>(url, { timeout: 10_000, service: 'github' });
    } catch (error) {
      console.warn('[PluginUpdate] Manifest fetch failed, skipping check:', error);
      return;
    }

    const allVersions = (Array.isArray(manifest) ? manifest : [])
      .flatMap((entry) => entry.versions ?? [])
      .map((v) => v.version)
      .filter((v): v is string => typeof v === 'string');
    const latest = maxVersion(allVersions);
    if (!latest) {
      console.warn('[PluginUpdate] No parseable versions in manifest, skipping check');
      return;
    }

    sseManager.setLatestPluginVersion(latest);

    const allServers = await db.select().from(servers);
    for (const server of allServers) {
      if (server.type === 'plex') continue;
      if (sseManager.isInFallback(server.id)) continue;

      const installed = sseManager.getPluginVersion(server.id);
      const outdated = installed === null || compareVersions(installed, latest) < 0;
      if (!outdated) {
        nudgedVersions.delete(server.id);
        continue;
      }
      if (nudgedVersions.get(server.id) === latest) continue;

      nudgedVersions.set(server.id, latest);
      await enqueueNotification({
        type: 'plugin_update_available',
        payload: {
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          installedVersion: installed,
          latestVersion: latest,
          downloadUrl: RELEASES_URL,
        },
      });
      console.log(
        `[PluginUpdate] ${server.name}: plugin ${installed ?? 'pre-0.2.0'} -> ${latest} available`
      );
    }
  } catch (error) {
    console.error('[PluginUpdate] Check failed:', error);
  }
}

export function startPluginUpdateChecker(): void {
  if (checkTimer || initialTimer) return;
  // Wait for SSE connections and their hello frames to land before the first check
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runPluginUpdateCheck();
  }, INITIAL_DELAY_MS);
  checkTimer = setInterval(() => void runPluginUpdateCheck(), CHECK_INTERVAL_MS);
  console.log('[PluginUpdate] Checker started (every 6h)');
}

export function stopPluginUpdateChecker(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
