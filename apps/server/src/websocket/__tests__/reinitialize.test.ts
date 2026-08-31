import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { WS_EVENTS } from '@tracearr/shared';

vi.mock('../../lib/sessionResolver.js', () => ({
  resolveBetterAuthSession: vi.fn().mockResolvedValue({
    sessionId: 'ses1',
    user: { userId: 'u1', username: 'owner', role: 'owner', serverIds: ['s1'] },
  }),
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

import { initializeWebSocket, broadcastToSessions } from '../index.js';

function once<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (...args: unknown[]) => void));
}

describe('initializeWebSocket', () => {
  it('reuses the server on a second call so clients already attached keep getting broadcasts', async () => {
    const httpServer = createServer();
    const first = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const client = connect(`http://localhost:${(httpServer.address() as AddressInfo).port}`, {
      auth: { token: 't' },
    });
    await once(client, 'connect');

    // What the maintenance recovery loop does: run post-listen init again
    expect(initializeWebSocket(httpServer)).toBe(first);

    const delivered = once(client, WS_EVENTS.SESSION_STOPPED);
    broadcastToSessions(WS_EVENTS.SESSION_STOPPED, 'sess-1');
    await delivered;

    client.disconnect();
    await first.close();
  });
});
