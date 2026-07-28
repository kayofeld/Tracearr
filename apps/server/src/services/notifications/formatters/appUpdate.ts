/**
 * Shared app (Tracearr release) update formatting utilities
 */

import type { AppUpdateContext } from '../types.js';

/**
 * Format an app update notification message, shared across all agents.
 */
export function formatAppUpdateMessage(ctx: AppUpdateContext): string {
  return `A new Tracearr release is available (current ${ctx.currentVersion}, latest ${ctx.latestVersion}): ${ctx.releaseUrl}`;
}
