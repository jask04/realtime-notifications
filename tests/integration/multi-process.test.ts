import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import type { Worker } from 'bullmq';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  notificationQueues,
  enqueueNotification,
} from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';
import { createWebsocketWorker } from '../../src/workers/websocket.worker.js';
import { getSockets } from '../../src/ws/registry.js';

let app: Awaited<ReturnType<typeof createApp>>;
let replica: ChildProcess;
let worker: Worker;
let url: string;
let token: string;
let userId: string;
const email = `multiprocess+${Date.now()}@test.local`;

beforeAll(async () => {
  await Promise.all(
    notificationQueues.map((q) => q.obliterate({ force: true })),
  );
  await deadLetterQueue.obliterate({ force: true });
  app = await createApp();
  await app.ready();
  const response = await app.inject({
    method: 'POST',
    url: '/auth/dev-token',
    payload: { email },
  });
  ({
    token,
    user: { id: userId },
  } = response.json());

  replica = fork(new URL('../fixtures/api-process.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env },
  });
  let startupError = '';
  replica.stderr?.on('data', (data: Buffer) => {
    startupError += data.toString();
  });
  const ready = once(replica, 'message', { signal: AbortSignal.timeout(8000) });
  replica.once('exit', (code) => {
    if (code) console.error(`API replica exited (${code}): ${startupError}`);
  });
  const [message] = await ready;
  url = (message as { url: string }).url;
  worker = createWebsocketWorker();
}, 10_000);

afterAll(async () => {
  await worker?.close();
  if (replica?.connected) {
    const exited = once(replica, 'exit', { signal: AbortSignal.timeout(5000) });
    replica.send('shutdown');
    try {
      await exited;
    } catch {
      replica.kill();
    }
  }
  await app?.close();
  await prisma.user.deleteMany({ where: { email } });
  await Promise.all(notificationQueues.map((q) => q.close()));
  await deadLetterQueue.close();
  await prisma.$disconnect();
  await redis.quit();
});

test('a worker delivers to a user connected only to another process', async () => {
  const client = ioClient(url, {
    autoConnect: false,
    reconnection: false,
    auth: { token },
  });
  const connected = once(client, 'connected', {
    signal: AbortSignal.timeout(5000),
  });
  client.connect();
  try {
    await connected;
    expect(getSockets(userId)).toEqual([]);
    const notification = await prisma.notification.create({
      data: {
        userId,
        channel: 'websocket',
        type: 'remote',
        payload: { title: 'remote' },
      },
    });
    const delivered = once(client, 'notification', {
      signal: AbortSignal.timeout(5000),
    });
    await enqueueNotification(
      {
        notificationId: notification.id,
        userId,
        channel: 'websocket',
        payload: { title: 'remote' },
      },
      { attempts: 1, backoff: undefined },
    );
    const [event] = await delivered;
    expect(event.id).toBe(notification.id);
    expect(event.payload).toEqual({ title: 'remote' });
    await vi.waitFor(async () => {
      const row = await prisma.notification.findUnique({
        where: { id: notification.id },
      });
      expect(row?.status).toBe('SENT');
    });
  } finally {
    client.close();
  }
});
