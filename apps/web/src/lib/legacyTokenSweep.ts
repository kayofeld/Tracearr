import { tokenStorage } from '@/lib/api';

/**
 * One-time boot sweep of legacy localStorage auth tokens. Cookie sessions
 * replaced these tokens; until the remaining writers (Login.tsx,
 * ServerSettings.tsx) are removed in a follow-up task, a token written
 * during a session can still exist until the next boot - that's expected
 * during the transition.
 */
export function sweepLegacyTokens(): void {
  tokenStorage.clearTokens(true);
}
