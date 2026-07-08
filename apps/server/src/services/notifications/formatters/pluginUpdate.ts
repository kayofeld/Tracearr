/**
 * Shared plugin update formatting utilities
 */

import type { PluginUpdateContext } from '../types.js';

/**
 * Format a plugin update notification message with server-aware copy.
 * Jellyfin plugins are updated from the dashboard; Emby plugins require a manual download.
 */
export function formatPluginUpdateMessage(ctx: PluginUpdateContext): string {
  const installed = ctx.installedVersion ?? 'pre-0.2.0';

  if (ctx.serverType === 'jellyfin') {
    return `Update the Tracearr SSE plugin in Dashboard > Plugins (installed ${installed}, latest ${ctx.latestVersion})`;
  }

  return `Download the new Tracearr SSE plugin build (installed ${installed}, latest ${ctx.latestVersion}): ${ctx.downloadUrl}`;
}
