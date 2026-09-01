/**
 * Deep links to a single item in a media server's own web client. Formats
 * verified against Plex 1.43.3, Emby 4.9.5.0 and Jellyfin 12.0.0, which agree
 * on nothing: Plex routes through app.plex.tv (a LAN URL is useless to remote
 * users) and needs machineIdentifier, Emby needs `#!` and a serverId or the
 * page 404s, Jellyfin needs a bare `#` and the item id alone.
 *
 * Null means a required identifier is missing; link to the server root.
 */

import type { ServerType } from './types.js';

export interface MediaServerItemLinkInput {
  serverType: ServerType;
  /** Server URL as configured in Tracearr. Ignored for Plex. */
  baseUrl: string;
  /** Item id on that server: Plex ratingKey, Emby/Jellyfin item id. */
  ratingKey: string;
  /** The media server's own id, not Tracearr's server row id. */
  machineIdentifier?: string | null;
}

const PLEX_APP_BASE = 'https://app.plex.tv/desktop';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildMediaServerItemUrl({
  serverType,
  baseUrl,
  ratingKey,
  machineIdentifier,
}: MediaServerItemLinkInput): string | null {
  if (!ratingKey) return null;

  switch (serverType) {
    case 'plex': {
      if (!machineIdentifier) return null;
      const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
      return `${PLEX_APP_BASE}/#!/server/${encodeURIComponent(machineIdentifier)}/details?key=${key}`;
    }
    case 'emby': {
      if (!machineIdentifier) return null;
      const root = trimTrailingSlash(baseUrl);
      if (!root) return null;
      return `${root}/web/index.html#!/item?id=${encodeURIComponent(ratingKey)}&serverId=${encodeURIComponent(machineIdentifier)}`;
    }
    case 'jellyfin': {
      const root = trimTrailingSlash(baseUrl);
      if (!root) return null;
      return `${root}/web/index.html#/details?id=${encodeURIComponent(ratingKey)}`;
    }
    default:
      return null;
  }
}
