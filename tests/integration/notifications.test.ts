import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { notificationQueue } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';
import { redis } from '../../src/queue/connection.js';
import { releaseReservation } from '../../src/services/idempotency.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

interface NotificationBody {
  notification: {
    id: string;
    userId: string;
    type: string;
    channel: string;
    status: string;
    idempotencyKey: string | null;
    payload: Record<string, unknown>;
  };
}

describe('POST /notifications', () => {
  let app: App;
  let token: string;
  let userId: string;
  const email = `notif+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    // Fresh queue state so 'waiting' assertions aren't polluted by leftovers
    // from previous runs.
    await notificationQueue.obliterate({ force: true });
    await deadLetterQueue.obliterate({ force: true });

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
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await notificationQueue.close();
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    // Each test starts from a clean slate for queue + notifications so we
    // can make exact count assertions.
    await notificationQueue.obliterate({ force: true });
    await prisma.notification.deleteMany({ where: { userId } });
  });

  test('returns 401 without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      payload: {
        userId,
        type: 'greeting',
        channel: 'websocket',
        payload: { title: 'hi' },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test('creates a notification and enqueues a job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId,
        type: 'greeting',
        channel: 'websocket',
        payload: { title: 'hello world' },
      },
    });

    expect(res.statusCode).toBe(201);
    const { notification } = res.json() as NotificationBody;
    expect(notification.userId).toBe(userId);
    expect(notification.channel).toBe('websocket');
    expect(notification.status).toBe('QUEUED');

    const row = await prisma.notification.findUnique({
      where: { id: notification.id },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('QUEUED');

    const waiting = await notificationQueue.getJobs(['waiting']);
    const matching = waiting.filter(
      (j) => (j.data as { notificationId?: string }).notificationId === notification.id,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.data).toMatchObject({
      userId,
      channel: 'websocket',
      payload: { title: 'hello world' },
    });
  });

  test('same idempotencyKey returns the original notification and does not enqueue twice', async () => {
    const idempotencyKey = `test-key-${Date.now()}`;
    // Defensive: make sure no leftover reservation exists from a prior run.
    await releaseReservation(idempotencyKey);

    const first = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId,
        type: 'greeting',
        channel: 'email',
        payload: { subject: 'hi' },
        idempotencyKey,
      },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as NotificationBody;

    const second = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId,
        type: 'greeting',
        channel: 'email',
        payload: { subject: 'hi' },
        idempotencyKey,
      },
    });
    // Duplicate replays return 200 with the already-created row, not a fresh 201.
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as NotificationBody;
    expect(secondBody.notification.id).toBe(firstBody.notification.id);

    const rows = await prisma.notification.findMany({
      where: { userId, idempotencyKey },
    });
    expect(rows).toHaveLength(1);

    const waiting = await notificationQueue.getJobs(['waiting']);
    const matching = waiting.filter(
      (j) => (j.data as { notificationId?: string }).notificationId === firstBody.notification.id,
    );
    expect(matching).toHaveLength(1);
  });

  test('rejects unknown channel with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId,
        type: 'greeting',
        channel: 'sms',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('returns 404 when recipient does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: 'nonexistent-user-id',
        type: 'greeting',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
