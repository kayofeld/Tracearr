import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { WS_EVENTS } from '@tracearr/shared';

vi.mock('../../lib/sessionResolver.js', () => ({
  resolveBetterAuthSession: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  },
}));

import { resolveBetterAuthSession } from '../../lib/sessionResolver.js';
import { initializeWebSocket } from '../index.js';

const resolveSession = vi.mocked(resolveBetterAuthSession);
let httpServer: HttpServer;
let io: ReturnType<typeof initializeWebSocket>;
let url: string;

function once<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (...args: unknown[]) => void));
}

beforeAll(async () => {
  httpServer = createServer();
  io = initializeWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

beforeEach(() => {
  resolveSession.mockReset();
  resolveSession.mockResolvedValue({
    sessionId: 'ses1',
    user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: ['s1'] },
  });
});

describe('connection state recovery', () => {
  it('recovers the session after an abrupt transport drop and re-runs auth', async () => {
    const client = connect(url, {
      auth: { token: 't' },
      reconnectionDelay: 10,
      reconnectionDelayMax: 20,
    });
    await once(client, 'connect');
    expect(client.recovered).toBeFalsy();
    expect(resolveSession).toHaveBeenCalledTimes(1);

    // Recovery needs an offset, so the client has to have seen one event first
    const delivered = once(client, WS_EVENTS.SESSION_STOPPED);
    io.emit(WS_EVENTS.SESSION_STOPPED, 'sess-1');
    await delivered;

    const reconnected = once(client, 'connect');
    client.io.engine.close();
    await reconnected;

    expect(client.recovered).toBe(true);
    expect(resolveSession).toHaveBeenCalledTimes(2);

    client.disconnect();
  });
});
