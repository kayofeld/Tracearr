import { formatEpisodeLabel } from '@tracearr/shared';
import type { ActiveSession } from '../types.js';

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/** Get display title for media (matches UI card logic) */
export function getMediaDisplay(session: ActiveSession): {
  title: string;
  subtitle: string | null;
} {
  if (session.mediaType === 'episode' && session.grandparentTitle) {
    const episodeInfo =
      formatEpisodeLabel(session.seasonNumber, session.episodeNumber, { spaced: true }) ?? '';
    return {
      title: session.grandparentTitle,
      subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
    };
  }
  return {
    title: session.mediaTitle,
    subtitle: session.year ? `${session.year}` : null,
  };
}

/** Get playback type (matches UI badge logic) */
export function getPlaybackType(session: ActiveSession): string {
  if (session.isTranscode) {
    return 'Transcode';
  }
  if (session.videoDecision === 'copy' || session.audioDecision === 'copy') {
    return 'Direct Stream';
  }
  return 'Direct Play';
}

export function getUserDisplayName(session: ActiveSession): string {
  return session.user.identityName ?? session.user.username;
}
