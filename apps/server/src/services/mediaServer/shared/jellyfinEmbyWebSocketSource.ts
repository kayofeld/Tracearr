/**
 * Jellyfin / Emby native WebSocket session source
 *
 * A plugin-free real-time tier. Jellyfin and Emby both expose a built-in
 * WebSocket that, once sent a `SessionsStart` message, pushes the full session
 * list on an interval. We diff consecutive snapshots and, when something the
 * poller cares about changes (a stream starts/stops, pauses/resumes, or swaps
 * item), emit a `session:event` — the exact same trigger contract the plugin
 * SSE source emits, so the manager's trigger-poll wiring is reused verbatim.
 *
 * We do NOT feed session data straight through: the emitted event is only a
 * nudge, and the existing poll pipeline fetches + reconciles authoritative
 * state. That keeps this source a thin, well-bounded change detector.
 *
 * Emby validated live (4.9.5): `wss://host/embywebsocket?api_key=...`,
 * `{"MessageType":"SessionsStart","Data":"0,1500"}` -> repeated
 * `{"MessageType":"Sessions","Data":[...]}`. Jellyfin uses `/socket`.
 */

import { EventEmitter } from 'events';
import { SSE_CONFIG, type SSEConnectionState } from '@tracearr/shared';
import type { PluginSessionEvent } from './jellyfinEmbyEventSource.js';

// Native WebSocket endpoint path per server type.
export const NATIVE_WS_PATH: Record<'jellyfin' | 'emby', string> = {
  jellyfin: '/socket',
  emby: '/embywebsocket',
};

// SessionsStart payload: "<initialDelayMs>,<intervalMs>". A short interval keeps
// the change-detection latency low; the pushes are cheap to diff.
const SESSIONS_INTERVAL_MS = 1500;
const SUBSCRIBE_PAYLOAD = `0,${SESSIONS_INTERVAL_MS}`;

// Observed on Emby 4.9.5: a SessionsStart sent immediately on open was ignored
// once. If no Sessions frame arrives within this window, re-subscribe.
const SUBSCRIBE_CONFIRM_TIMEOUT_MS = 5000;

// No Sessions frame for this long => assume the socket died. The server pushes
// every ~1.5s, so 15s is ~10 missed frames.
const HEARTBEAT_TIMEOUT_MS = 15000;

interface RawSession {
  Id?: unknown;
  UserId?: unknown;
  NowPlayingItem?: { Id?: unknown } | null;
  PlayState?: { IsPaused?: unknown; PlayMethod?: unknown } | null;
}

/**
 * Build the set of change-significant signatures for a snapshot. Position is
 * deliberately excluded: it changes every frame and would make every push look
 * like a change, defeating the point (we'd poll as often as plain polling).
 * A signature captures the facts a poll would react to: which playing session,
 * on what item, paused or not, and the play method (transcode vs direct).
 */
export function sessionSignatures(sessions: unknown): Set<string> {
  const sigs = new Set<string>();
  if (!Array.isArray(sessions)) return sigs;

  for (const raw of sessions as RawSession[]) {
    const nowPlaying = raw?.NowPlayingItem;
    if (!nowPlaying) continue; // only playing sessions matter to the poller
    const sessionId = String(raw?.Id ?? '');
    const itemId = String(nowPlaying?.Id ?? '');
    const isPaused = raw?.PlayState?.IsPaused === true ? '1' : '0';
    const playMethod = String(raw?.PlayState?.PlayMethod ?? '');
    sigs.add(`${sessionId}:${itemId}:${isPaused}:${playMethod}`);
  }
  return sigs;
}

/** True if two signature sets differ (a stream started/stopped/changed state). */
export function snapshotsDiffer(prev: Set<string>, next: Set<string>): boolean {
  if (prev.size !== next.size) return true;
  for (const sig of next) if (!prev.has(sig)) return true;
  return false;
}

let WebSocketImpl: typeof WebSocket = globalThis.WebSocket;

/** Test seam: inject a mock WebSocket constructor. */
export function setWebSocketImpl(impl: typeof WebSocket): void {
  WebSocketImpl = impl;
}

export class JellyfinEmbyWebSocketSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly baseUrl: string;
  private readonly serverType: 'jellyfin' | 'emby';
  private readonly token: string;

  private ws: WebSocket | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private previousSignatures = new Set<string>();
  private hadFirstSnapshot = false;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private subscribeConfirmTimer: NodeJS.Timeout | null = null;

  private connectedAt: Date | null = null;
  private lastEventTime: Date | null = null;
  private lastError: Error | null = null;

  constructor(config: {
    serverId: string;
    serverName: string;
    url: string;
    serverType: 'jellyfin' | 'emby';
    token: string;
  }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.baseUrl = config.url.replace(/\/$/, '');
    this.serverType = config.serverType;
    this.token = config.token;
  }

  getState(): SSEConnectionState {
    return this.state;
  }

  getStatus() {
    return {
      serverId: this.serverId,
      serverName: this.serverName,
      state: this.state,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
      error: this.lastError?.message ?? null,
      pluginVersion: null,
    };
  }

  private setState(state: SSEConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('connection:state', state);
  }

  private wsUrl(): string {
    const scheme = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = this.baseUrl.replace(/^https?/, scheme);
    const deviceId = `tracearr-${this.serverId}`;
    return `${host}${NATIVE_WS_PATH[this.serverType]}?api_key=${encodeURIComponent(
      this.token
    )}&deviceId=${encodeURIComponent(deviceId)}`;
  }

  connect(): void {
    this.clearTimers();
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(this.wsUrl());
    } catch (error) {
      this.handleError(error);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connectedAt = new Date();
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.subscribe();
      // If the first Sessions frame never lands, the subscribe was dropped
      // (observed on Emby) — re-send once, then let the heartbeat reconnect.
      this.subscribeConfirmTimer = setTimeout(() => {
        if (!this.hadFirstSnapshot) this.subscribe();
      }, SUBSCRIBE_CONFIRM_TIMEOUT_MS);
      this.resetHeartbeat();
    };

    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onerror = () => this.handleError(new Error('WebSocket error'));
    ws.onclose = () => {
      if (this.state !== 'disconnected') this.handleError(new Error('WebSocket closed'));
    };
  }

  private subscribe(): void {
    try {
      this.ws?.send(JSON.stringify({ MessageType: 'SessionsStart', Data: SUBSCRIBE_PAYLOAD }));
    } catch {
      // send on a closing socket throws; the close/error path handles recovery
    }
  }

  private handleMessage(data: unknown): void {
    this.lastEventTime = new Date();
    this.resetHeartbeat();

    let msg: { MessageType?: unknown; Data?: unknown };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as {
        MessageType?: unknown;
        Data?: unknown;
      };
    } catch {
      return; // non-JSON keep-alive; liveness already recorded above
    }
    if (msg.MessageType !== 'Sessions') return;

    if (this.subscribeConfirmTimer) {
      clearTimeout(this.subscribeConfirmTimer);
      this.subscribeConfirmTimer = null;
    }

    const signatures = sessionSignatures(msg.Data);
    // First snapshot establishes a baseline without firing (the poller already
    // ran on connect); subsequent changes trigger a poll.
    if (!this.hadFirstSnapshot) {
      this.hadFirstSnapshot = true;
      this.previousSignatures = signatures;
      return;
    }
    if (snapshotsDiffer(this.previousSignatures, signatures)) {
      this.previousSignatures = signatures;
      const payload: PluginSessionEvent = {
        sessionId: '',
        itemId: null,
        userId: null,
        state: 'change',
        positionTicks: null,
      };
      this.emit('session:event', payload);
    }
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.handleError(new Error('Heartbeat timeout: no Sessions frame'));
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.lastError = err;
    this.emit('connection:error', err);
    this.cleanupSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      // Budget spent — hand off to polling and retry later from fallback.
      this.setState('fallback');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.connect();
      }, SSE_CONFIG.MAX_RETRY_DELAY_MS);
      return;
    }

    const delay = Math.min(
      SSE_CONFIG.INITIAL_RETRY_DELAY_MS * SSE_CONFIG.RETRY_MULTIPLIER ** this.reconnectAttempts,
      SSE_CONFIG.MAX_RETRY_DELAY_MS
    );
    this.reconnectAttempts += 1;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Poll reached the server while we were in fallback — retry sooner. */
  retryFromFallback(): void {
    if (this.state !== 'fallback') return;
    this.clearTimers();
    this.reconnectAttempts = 0;
    this.connect();
  }

  disconnect(): void {
    this.clearTimers();
    this.setState('disconnected');
    this.cleanupSocket();
    this.connectedAt = null;
    this.hadFirstSnapshot = false;
    this.previousSignatures = new Set();
  }

  private cleanupSocket(): void {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.subscribeConfirmTimer) clearTimeout(this.subscribeConfirmTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.subscribeConfirmTimer = null;
  }
}
