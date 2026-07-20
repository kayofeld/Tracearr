# ADR 0001: Use Emby's native WebSocket for real-time sessions (spike result)

Date: 2026-07-20 · Status: Proposed (spike validated live) · Owner: coordinator + Paul

## Context

Tracearr's real-time session detection for Emby depends on the external
[Tracearr SSE plugin](https://github.com/Tracearr/Media-Server-SSE) (`/emby/sse/events`);
without it, Emby falls back to HTTP polling (`jellyfinEmbyEventSource.ts`, 3-min re-probe).
Emby's closed plugin ecosystem makes the plugin path more fragile than on Jellyfin.
Emby ships a native WebSocket at `/embywebsocket` that clients use for live session data.

## Spike (validated 2026-07-20 against draner.pet, Emby 4.9.5.0, 39 sessions / 1 playing)

- `wss://<host>/embywebsocket?api_key=<key>&deviceId=<id>` connects with a plain API key.
- Sending `{"MessageType":"SessionsStart","Data":"0,1500"}` subscribes to session pushes.
- Server then pushes `{"MessageType":"Sessions","Data":[...]}` on the requested cadence
  (~1.5-2.5s observed). The payload is the SAME shape as `GET /Sessions` - PlayState
  (IsPaused, PositionTicks, PlayMethod), NowPlayingItem, TranscodingInfo, RemoteEndPoint,
  UserId/UserName, Client/Device - i.e. exactly what `parseSessionsResponse` already parses
  for the poller. No new parser needed.
- **Caveat 1 - subscribe race:** a `SessionsStart` sent immediately in `onopen` was ignored
  once (zero messages for 20s); a re-sent subscribe a few seconds later took effect.
  Implementation must delay/retry the subscribe and treat "no message within N s" as
  re-subscribe, not silence. (Could also be proxy-related; verify against a direct
  connection during implementation.)
- **Caveat 2 - snapshots, not deltas:** pushes are full session arrays (~64 KB with 39
  device sessions), interval-driven - "server-side polling pushed over WS", not
  event-per-change like the SSE plugin's `session:event`. Bandwidth scales with device
  count, not activity. A 2-5s interval is the sane default.

## Decision (proposed)

Add a native-WebSocket event source for Emby (and likely Jellyfin - same socket exists at
`/socket`) as the **middle tier** of a three-tier real-time strategy:

1. SSE plugin (event-level, richest) - keep as first choice when installed;
2. **native WebSocket `SessionsStart` (no install, ~2s freshness) - new default fallback;**
3. HTTP polling - last resort (WS blocked by proxy, ancient server).

Reuses `parseSessionsResponse` on the pushed payload; state diffing stays in the existing
poller/session-lifecycle code (the WS feed effectively replaces the HTTP fetch tick).

## Consequences

- Real-time-ish Emby sessions with zero plugin installation; removes the biggest
  Emby-vs-Plex UX gap for most users.
- No new parsing surface; the risky part is connection lifecycle (subscribe race,
  heartbeat, reconnect budget) - mirror `jellyfinEmbyEventSource`'s state machine.

* More moving parts in the fallback chain; the status UI ("SSE / fallback") needs a third
  state so operators can see which tier is live.
* Payload size on large households; interval must be configurable.

## Follow-ups before implementation

- Verify the subscribe race root cause (direct vs proxied connection).
- Check Jellyfin's `/socket` equivalence to share the implementation.
- Decide upstream-maintainer buy-in: this touches their plugin strategy - propose in a
  GitHub Discussion before building (repo rule: features discussed first).
