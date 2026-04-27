import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import { notificationQueues } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';
import { getSockets, isOnline } from '../../src/ws/registry.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

/**
 * Wait for a one-shot socket event with a timeout, so a missed event fails
 * the test loud and fast instead of hanging until vitest's testTimeout.
 */
function waitFor<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('WebSocket handshake', () => {
  let app: App;
  let url: string;
  let token: string;
  let userId: string;
  const email = `ws+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    // Port 0 -> OS-assigned ephemeral port; 127.0.0.1 keeps the test off
    // any LAN listeners and avoids IPv6 surprises in CI.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });
    const body = res.json() as TokenBody;
    token = body.token;
    userId = body.user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('rejects connections with no token', async () => {
    const socket = ioClient(url, { reconnection: false });
    try {
      const err = await waitFor<Error>(socket, 'connect_error');
      expect(err.message).toMatch(/missing/i);
    } finally {
      socket.close();
    }
  });

  test('rejects connections with an invalid token', async () => {
    const socket = ioClient(url, {
      reconnection: false,
      auth: { token: 'not.a.real.jwt' },
    });
    try {
      const err = await waitFor<Error>(socket, 'connect_error');
      expect(err.message).toMatch(/invalid/i);
    } finally {
      socket.close();
    }
  });

  test('valid token: connects, receives "connected" with userId, registry knows about it', async () => {
    const socket = ioClient(url, { reconnection: false, auth: { token } });
    // Attach listeners before awaiting — the server emits "connected"
    // immediately on connection, so awaiting "connect" first would race
    // past it.
    const connectedPromise = waitFor<{ userId: string }>(socket, 'connected');
    try {
      await waitFor(socket, 'connect');
      const payload = await connectedPromise;
      expect(payload.userId).toBe(userId);

      // Server-side bookkeeping should reflect the live connection.
      expect(isOnline(userId)).toBe(true);
      expect(getSockets(userId)).toHaveLength(1);
    } finally {
      socket.close();
    }
  });

  test('disconnect removes the socket from the registry', async () => {
    const socket = ioClient(url, { reconnection: false, auth: { token } });
    const connectedPromise = waitFor(socket, 'connected');
    await waitFor(socket, 'connect');
    await connectedPromise;

    socket.close();

    // The server's `disconnect` handler runs asynchronously after the socket
    // closes; poll briefly instead of asserting immediately.
    const deadline = Date.now() + 1000;
    while (isOnline(userId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(isOnline(userId)).toBe(false);
  });

  test('two simultaneous connections for the same user both register', async () => {
    const a = ioClient(url, { reconnection: false, auth: { token } });
    const b = ioClient(url, { reconnection: false, auth: { token } });
    // Attach the "connected" listeners before awaiting "connect" — same
    // race as in the single-socket test.
    const connectedA = waitFor(a, 'connected');
    const connectedB = waitFor(b, 'connected');
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      await Promise.all([connectedA, connectedB]);
      expect(getSockets(userId).length).toBeGreaterThanOrEqual(2);
    } finally {
      a.close();
      b.close();
    }
  });
});
