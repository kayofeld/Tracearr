/**
 * Shared update formatting for the media server and Tracearr release events.
 */

import type { ServerUpdateContext, TracearrUpdateContext } from '../types.js';

export function formatServerUpdateMessage(ctx: ServerUpdateContext): string {
  return `${ctx.serverName} can update from ${ctx.installedVersion} to ${ctx.latestVersion}: ${ctx.releaseUrl}`;
}

export function formatTracearrUpdateMessage(ctx: TracearrUpdateContext): string {
  return `Tracearr ${ctx.latest} is out (running ${ctx.current}): ${ctx.releaseUrl}`;
}
