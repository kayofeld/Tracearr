/**
 * Resolution Normalizer
 *
 * Normalizes video resolution from various sources (Plex, Jellyfin, Emby)
 * into consistent, display-friendly labels for Tracearr.
 *
 * Thin wrapper around the shared classifier in @tracearr/shared/resolution -
 * kept so existing callers (session mapper, rules engine) don't need to
 * change their input shape.
 *
 * This utility is used by:
 * - Session mapper (for live sessions)
 * - Rules engine (for resolution-based conditions)
 */

import { normalizeResolution as normalizeResolutionShared } from '@tracearr/shared';

export interface ResolutionInput {
  /** Resolution string from API (e.g., "1080", "1080p", "4k", "sd") */
  resolution?: string;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels (used together with width to handle all aspect ratios) */
  height?: number;
}

/**
 * Normalize video resolution to a display-friendly label.
 *
 * Priority: server-provided resolution label over width/height dimensions.
 * Tautulli displays Plex's own `videoResolution` verbatim rather than
 * recomputing it from pixels - Plex already accounts for scan type and
 * aspect ratio server-side, so trust it over a recomputation that can land a
 * few pixels short of a clean cutoff (e.g. 1916 wide vs. the 1920 cutoff).
 * Dimensions are only the fallback when no label is available (Jellyfin/Emby,
 * or a Plex transcode session where only source pixels survive).
 *
 * @param input - Resolution data from media server
 * @returns Normalized resolution string (e.g., "4K", "1080p", "720p", "SD") or null
 *
 * @example
 * normalizeResolution({ resolution: '1080', width: 1916, height: 1036 }) // "1080p" (label wins)
 * normalizeResolution({ width: 1920, height: 800 })      // "1080p" (widescreen 2.40:1)
 * normalizeResolution({ width: 1440, height: 1080 })     // "1080p" (4:3 aspect ratio)
 * normalizeResolution({ resolution: '1080p' })           // "1080p"
 */
export function normalizeResolution(input: ResolutionInput): string | null {
  const { resolution, width, height } = input;
  return normalizeResolutionShared({ label: resolution, width, height });
}

/**
 * Build quality display string from session quality data
 *
 * @param quality - Session quality object
 * @returns Quality string for display (e.g., "4K", "1080p", "54 Mbps", "Direct")
 */
export function formatQualityString(quality: {
  videoResolution?: string;
  videoWidth?: number;
  videoHeight?: number;
  bitrate?: number;
  isTranscode?: boolean;
  streamVideoDetails?: { width?: number; height?: number };
}): string {
  const effectiveWidth = quality.isTranscode
    ? (quality.streamVideoDetails?.width ?? quality.videoWidth)
    : quality.videoWidth;
  const effectiveHeight = quality.isTranscode
    ? (quality.streamVideoDetails?.height ?? quality.videoHeight)
    : quality.videoHeight;

  // Prefer resolution-based display
  const resolution = normalizeResolution({
    resolution: quality.videoResolution,
    width: effectiveWidth,
    height: effectiveHeight,
  });

  if (resolution) {
    return resolution;
  }

  // Fall back to bitrate if available
  if (quality.bitrate && quality.bitrate > 0) {
    const mbps = quality.bitrate / 1000;
    const formatted = mbps % 1 === 0 ? mbps.toFixed(0) : mbps.toFixed(1);
    return `${formatted} Mbps`;
  }

  // Last resort: transcode status
  return quality.isTranscode ? 'Transcoding' : 'Direct';
}
