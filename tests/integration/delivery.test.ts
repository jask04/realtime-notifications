import type { AddressInfo } from 'node:net';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  enqueueNotification,
  notificationQueues,
} from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';
import { startWorkers, stopWorkers } from '../../src/workers/index.js';

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

describe('end-to-end websocket delivery', () => {
  let app: App;
  let url: string;
  let token: string;
  let userId: string;
  let workers: Worker[];
  const email = `delivery+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;

    workers = startWorkers();

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
    await stopWorkers(workers);
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    await Promise.all(
      notificationQueues.map((q) => q.obliterate({ force: true })),
    );
    await deadLetterQueue.obliterate({ force: true });
    await prisma.notification.deleteMany({ where: { userId } });
  });

  test('connected client receives a queued notification and DB flips to SENT', async () => {
    const socket = ioClient(url, { reconnection: false, auth: { token } });
    const connected = waitFor(socket, 'connected');
    const delivered = waitFor<{ id: string; type: string; payload: Record<string, unknown> }>(
      socket,
      'notification',
    );

    try {
      await waitFor(socket, 'connect');
      await connected;

      const postRes = await app.inject({
        method: 'POST',
        url: '/notifications',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          userId,
          type: 'greeting',
          channel: 'websocket',
          payload: { title: 'live!' },
        },
      });
      expect(postRes.statusCode).toBe(201);
      const { notification } = postRes.json() as {
        notification: { id: string };
      };

      const event = await delivered;
      expect(event.id).toBe(notification.id);
      expect(event.type).toBe('greeting');
      expect(event.payload).toEqual({ title: 'live!' });

      // Worker updates DB after the emit; poll briefly so we don't race it.
      const deadline = Date.now() + 2000;
      let row = await prisma.notification.findUnique({
        where: { id: notification.id },
      });
      while (row && row.status !== 'SENT' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        row = await prisma.notification.findUnique({
          where: { id: notification.id },
        });
      }
      expect(row?.status).toBe('SENT');
      expect(row?.deliveredAt).toBeInstanceOf(Date);
    } finally {
      socket.close();
    }
  });

  test('offline recipient: retries exhaust, job lands in DLQ, row marked DEAD_LETTER', async () => {
    // Don't connect a socket — userId is offline. Enqueue with attempts:1
    // so the failed-handler runs immediately rather than backing off.
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: 'silent',
        channel: 'websocket',
        payload: { title: 'into the void' },
      },
    });

    await enqueueNotification(
      {
        notificationId: notification.id,
        userId,
        channel: 'websocket',
        payload: { title: 'into the void' },
      },
      { attempts: 1, backoff: undefined },
    );

    // Wait for the row to settle into DEAD_LETTER.
    const deadline = Date.now() + 5000;
    let row = await prisma.notification.findUnique({
      where: { id: notification.id },
    });
    while (row && row.status !== 'DEAD_LETTER' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      row = await prisma.notification.findUnique({
        where: { id: notification.id },
      });
    }
    expect(row?.status).toBe('DEAD_LETTER');
    expect(row?.lastError).toMatch(/no active connections/);

    const dlqJobs = await deadLetterQueue.getJobs(['waiting']);
    const matching = dlqJobs.filter(
      (j) => j.data.originalJobId !== undefined && j.data.notificationId === notification.id,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.data.reason).toMatch(/no active connections/);
  });
});
