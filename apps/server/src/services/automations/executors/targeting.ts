import type { Session, SessionTarget } from '@tracearr/shared';

export interface TargetResolutionInput {
  target: SessionTarget | undefined;
  triggeringSession: Session;
  serverUserId: string;
  activeSessions: Session[];
  /** When set (opt-in via a rule's enforceAcrossServers), sessions are matched
   *  against every server_user id in this identity instead of just
   *  serverUserId, so actions can target sibling-server sessions too. */
  identityServerUserIds?: string[];
}

/**
 * Resolve which sessions should be targeted by an action.
 */
export function resolveTargetSessions(input: TargetResolutionInput): Session[] {
  const { target, triggeringSession, serverUserId, activeSessions, identityServerUserIds } = input;

  const matchesTarget =
    identityServerUserIds && identityServerUserIds.length > 0
      ? (() => {
          const idSet = new Set(identityServerUserIds);
          return (s: Session) => idSet.has(s.serverUserId);
        })()
      : (s: Session) => s.serverUserId === serverUserId;

  // Filter to only this user's (or identity's) sessions, sorted oldest first
  const userSessions = activeSessions
    .filter(matchesTarget)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  switch (target) {
    case 'triggering':
      return [triggeringSession];

    case 'oldest': {
      const [oldest] = userSessions;
      return oldest ? [oldest] : [];
    }

    case 'newest': {
      const newest = userSessions[userSessions.length - 1];
      return newest ? [newest] : [];
    }

    case 'all_except_one':
      return userSessions.slice(1);

    case 'all_user':
      return userSessions;

    default:
      return [triggeringSession];
  }
}
