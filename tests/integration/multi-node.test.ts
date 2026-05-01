import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import { notificationQueues } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

function waitFor<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 3000,
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

/**
 * Two Fastify apps in the same test, each with its own Socket.io server,
 * sharing Redis through the adapter. A client connects to app A only;
 * app B emits to that client's socket id. With the adapter wired,
 * app B publishes the emit over Redis pub/sub and app A delivers it.
 * Without the adapter, app B has no local socket with that id and the
 * emit is a silent no-op — so a passing test proves the adapter is doing
 * the cross-node routing.
 */
describe('Socket.io Redis adapter — cross-node delivery', () => {
  let appA: App;
  let appB: App;
  let urlA: string;
  let token: string;
  let userId: string;
  const email = `multinode+${Date.now()}@test.local`;

  beforeAll(async () => {
    appA = await createApp();
    await appA.listen({ port: 0, host: '127.0.0.1' });
    const addrA = appA.server.address() as AddressInfo;
    urlA = `http://127.0.0.1:${addrA.port}`;

    appB = await createApp();
    await appB.listen({ port: 0, host: '127.0.0.1' });

    const res = await appA.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });
    const body = res.json() as TokenBody;
    token = body.token;
    userId = body.user.id;
  });

  afterAll(async () => {
    // Close in reverse-registration order so the singleton clean-up in
    // ws/server.ts (which only nils `activeIo` if it still owns it)
    // works without surprise.
    await appB.close();
    await appA.close();

    await prisma.user.deleteMany({ where: { email } });
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('emit from app B reaches a client connected to app A', async () => {
    const client = ioClient(urlA, { reconnection: false, auth: { token } });
    // Stage listeners up-front so we don't race the server-side emit. The
    // adapter still has to publish over Redis so the recipient app A
    // receives the message; that's a couple of ms beyond local emit.
    const connected = waitFor<{ userId: string }>(client, 'connected');
    const crossNode = waitFor<{ msg: string; from: string }>(
      client,
      'cross-node',
      4000,
    );

    try {
      await waitFor(client, 'connect');
      await connected;
      // Defensive small pause so the adapter's room registration has
      // certainly propagated. With io.to(socketId) the room is the
      // socket's own auto-joined room, which is set on connection — but
      // pub/sub delivery is asynchronous.
      await new Promise((r) => setTimeout(r, 50));

      // Emit through app B's io, which has no local socket with this id.
      // The adapter publishes a "to room=client.id" message; app A's
      // adapter sees it and emits to its locally-connected socket.
      appB.io.to(client.id!).emit('cross-node', {
        msg: 'hello from B',
        from: 'app-b',
      });

      const event = await crossNode;
      expect(event.msg).toBe('hello from B');
      expect(event.from).toBe('app-b');
    } finally {
      client.close();
    }
  });

  test('broadcast from app B reaches all sockets, including those on app A', async () => {
    const a = ioClient(urlA, { reconnection: false, auth: { token } });
    const b = ioClient(urlA, { reconnection: false, auth: { token } });
    const aReceived = waitFor<{ msg: string }>(a, 'broadcast', 4000);
    const bReceived = waitFor<{ msg: string }>(b, 'broadcast', 4000);

    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      await new Promise((r) => setTimeout(r, 50));

      // No room qualifier — fans out to every connected socket via Redis.
      appB.io.emit('broadcast', { msg: 'hello, all nodes' });

      const [evA, evB] = await Promise.all([aReceived, bReceived]);
      expect(evA.msg).toBe('hello, all nodes');
      expect(evB.msg).toBe('hello, all nodes');
    } finally {
      a.close();
      b.close();
    }
  });
});
