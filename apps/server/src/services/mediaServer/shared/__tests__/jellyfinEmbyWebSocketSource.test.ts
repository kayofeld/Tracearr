import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JellyfinEmbyWebSocketSource,
  sessionSignatures,
  snapshotsDiffer,
  setWebSocketImpl,
  NATIVE_WS_PATH,
} from '../jellyfinEmbyWebSocketSource.js';
import type { PluginSessionEvent } from '../jellyfinEmbyEventSource.js';

// ---------------------------------------------------------------------------
// Pure diff helpers
// ---------------------------------------------------------------------------
describe('sessionSignatures', () => {
  it('ignores sessions with no NowPlayingItem', () => {
    const sigs = sessionSignatures([{ Id: 'a' }, { Id: 'b', NowPlayingItem: null }]);
    expect(sigs.size).toBe(0);
  });

  it('captures item, pause and play method but NOT position', () => {
    const base = {
      Id: 's1',
      NowPlayingItem: { Id: 'item1' },
      PlayState: { IsPaused: false, PlayMethod: 'DirectPlay', PositionTicks: 100 },
    };
    const moved = {
      ...base,
      PlayState: { IsPaused: false, PlayMethod: 'DirectPlay', PositionTicks: 999999 },
    };
    // Position-only change => same signature (would not trigger a poll)
    expect([...sessionSignatures([base])][0]).toBe([...sessionSignatures([moved])][0]);
  });
});

describe('snapshotsDiffer', () => {
  const sig = (s: unknown) => sessionSignatures(s);
  const playing = (id: string, item: string, paused = false) => ({
    Id: id,
    NowPlayingItem: { Id: item },
    PlayState: { IsPaused: paused, PlayMethod: 'DirectPlay' },
  });

  it('false when only position advanced', () => {
    expect(snapshotsDiffer(sig([playing('s1', 'i1')]), sig([playing('s1', 'i1')]))).toBe(false);
  });
  it('true when a new stream starts', () => {
    expect(
      snapshotsDiffer(sig([playing('s1', 'i1')]), sig([playing('s1', 'i1'), playing('s2', 'i2')]))
    ).toBe(true);
  });
  it('true when a stream stops', () => {
    expect(snapshotsDiffer(sig([playing('s1', 'i1')]), sig([]))).toBe(true);
  });
  it('true when a stream pauses', () => {
    expect(
      snapshotsDiffer(sig([playing('s1', 'i1', false)]), sig([playing('s1', 'i1', true)]))
    ).toBe(true);
  });
  it('true when a stream swaps item', () => {
    expect(snapshotsDiffer(sig([playing('s1', 'i1')]), sig([playing('s1', 'i2')]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle with a mock WebSocket
// ---------------------------------------------------------------------------
type Handler = ((ev: unknown) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() {
    this.onopen?.(undefined);
  }
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  raw(data: string) {
    this.onmessage?.({ data });
  }
}

const sessionsFrame = (sessions: unknown[]) => ({ MessageType: 'Sessions', Data: sessions });
const playing = (id: string, item: string, paused = false) => ({
  Id: id,
  NowPlayingItem: { Id: item },
  PlayState: { IsPaused: paused, PlayMethod: 'DirectPlay' },
});

function makeSource() {
  return new JellyfinEmbyWebSocketSource({
    serverId: 'srv1',
    serverName: 'Emby',
    url: 'https://emby.local',
    serverType: 'emby',
    token: 'tok en/+',
  });
}

describe('JellyfinEmbyWebSocketSource lifecycle', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    setWebSocketImpl(MockWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a wss url with the right path and url-encoded token', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url.startsWith(`wss://emby.local${NATIVE_WS_PATH.emby}?`)).toBe(true);
    expect(ws.url).toContain('api_key=tok%20en%2F%2B');
    src.disconnect();
  });

  it('subscribes with SessionsStart on open', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ MessageType: 'SessionsStart', Data: '0,1500' });
    src.disconnect();
  });

  it('does not fire on the first (baseline) snapshot, fires on a later change', () => {
    const src = makeSource();
    const events: PluginSessionEvent[] = [];
    src.on('session:event', (e) => events.push(e));
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();

    ws.message(sessionsFrame([playing('s1', 'i1')])); // baseline
    expect(events).toHaveLength(0);

    ws.message(sessionsFrame([playing('s1', 'i1')])); // no change (position aside)
    expect(events).toHaveLength(0);

    ws.message(sessionsFrame([playing('s1', 'i1'), playing('s2', 'i2')])); // new stream
    expect(events).toHaveLength(1);

    ws.message(sessionsFrame([playing('s1', 'i1', true), playing('s2', 'i2')])); // pause
    expect(events).toHaveLength(2);
    src.disconnect();
  });

  it('re-subscribes if no Sessions frame arrives within the confirm window', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    expect(ws.sent).toHaveLength(1);
    vi.advanceTimersByTime(5000); // SUBSCRIBE_CONFIRM_TIMEOUT_MS
    expect(ws.sent).toHaveLength(2); // re-sent
    expect(JSON.parse(ws.sent[1]!).MessageType).toBe('SessionsStart');
    src.disconnect();
  });

  it('does NOT re-subscribe once a Sessions frame has arrived', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(sessionsFrame([]));
    vi.advanceTimersByTime(5000);
    expect(ws.sent).toHaveLength(1); // no re-subscribe
    src.disconnect();
  });

  it('reconnects (new socket) after the heartbeat timeout', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(sessionsFrame([])); // starts heartbeat
    vi.advanceTimersByTime(15000); // HEARTBEAT_TIMEOUT_MS -> error -> schedule reconnect
    vi.advanceTimersByTime(1000); // INITIAL_RETRY_DELAY_MS
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    src.disconnect();
  });

  it('ignores non-JSON keep-alive frames without emitting', () => {
    const src = makeSource();
    const events: PluginSessionEvent[] = [];
    src.on('session:event', (e) => events.push(e));
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.raw('ping');
    expect(events).toHaveLength(0);
    expect(src.getState()).toBe('connected');
    src.disconnect();
  });

  it('emits connection:state connecting -> connected', () => {
    const states: string[] = [];
    const src = makeSource();
    src.on('connection:state', (s) => states.push(s));
    src.connect();
    MockWebSocket.instances[0]!.open();
    expect(states).toEqual(['connecting', 'connected']);
    src.disconnect();
    expect(states.at(-1)).toBe('disconnected');
  });

  it('replies to ForceKeepAlive with a KeepAlive (H1: jellyfin closes silent sockets)', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.sent.length = 0; // drop the SessionsStart
    ws.message({ MessageType: 'ForceKeepAlive', Data: 60 });
    expect(JSON.parse(ws.sent[0]!)).toEqual({ MessageType: 'KeepAlive' });
    src.disconnect();
  });

  it('sends periodic KeepAlive on a timer while connected', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    // Ongoing frames keep the heartbeat alive (as in production ~every 1.5s) so the
    // 30s KeepAlive interval can elapse without a heartbeat-triggered reconnect.
    for (let t = 0; t < 30000; t += 5000) {
      ws.message(sessionsFrame([]));
      vi.advanceTimersByTime(5000);
    }
    const types = ws.sent.map((s) => (JSON.parse(s) as { MessageType: string }).MessageType);
    expect(types).toContain('KeepAlive');
    src.disconnect();
  });

  it('closes and de-registers the old socket when reconnecting', () => {
    const src = makeSource();
    src.connect();
    const first = MockWebSocket.instances[0]!;
    first.open();
    first.message(sessionsFrame([]));
    vi.advanceTimersByTime(15000); // heartbeat timeout -> error -> reconnect scheduled
    vi.advanceTimersByTime(1000); // reconnect delay
    expect(first.closed).toBe(true);
    expect(first.onmessage).toBeNull();
    expect(MockWebSocket.instances.length).toBe(2);
    src.disconnect();
  });

  it('falls back after the retry budget, then re-probes after the fallback delay', () => {
    const states: string[] = [];
    const src = makeSource();
    src.on('connection:state', (s) => states.push(s));
    src.connect();
    // Fail every socket immediately on open by never opening; drive errors via close.
    // 10 attempts: exhaust the budget. Each connect creates a socket we then close.
    for (let i = 0; i < 11; i++) {
      const ws = MockWebSocket.instances.at(-1)!;
      ws.onclose?.(undefined); // triggers handleError -> scheduleReconnect
      vi.advanceTimersByTime(30000); // clear any backoff up to the cap
    }
    expect(states).toContain('fallback');
    src.disconnect();
  });

  it('disconnect cancels a pending reconnect (no new socket after)', () => {
    const src = makeSource();
    src.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(sessionsFrame([]));
    vi.advanceTimersByTime(15000); // heartbeat -> reconnect scheduled
    const count = MockWebSocket.instances.length;
    src.disconnect(); // must cancel the pending reconnect timer
    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances.length).toBe(count);
  });

  it('times out a stalled connect that never opens', () => {
    const errors: string[] = [];
    const src = makeSource();
    src.on('connection:error', (e) => errors.push(e.message));
    src.connect();
    // never call open()
    vi.advanceTimersByTime(15000); // connect timeout
    expect(errors.some((m) => /timeout/i.test(m))).toBe(true);
    src.disconnect();
  });

  it('never leaks the api_key when the WebSocket constructor throws (M2)', () => {
    // A ctor that throws with the URL (containing ?api_key=...) embedded.
    const throwingCtor = function (this: unknown, url: string) {
      throw new Error(`Invalid URL: ${url}`);
    };
    setWebSocketImpl(throwingCtor as unknown as typeof WebSocket);
    const errors: string[] = [];
    const src = makeSource();
    src.on('connection:error', (e) => errors.push(e.message));
    src.connect();
    expect(errors[0]).toBe('WebSocket construction failed');
    expect(errors.join()).not.toContain('api_key');
    src.disconnect();
  });
});
