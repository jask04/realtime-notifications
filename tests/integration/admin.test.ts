import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  notificationQueues,
  websocketQueue,
} from '../../src/queue/notifications.js';
import {
  deadLetterQueue,
  type DeadLetterJobData,
} from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string; role?: string };
}

async function getToken(
  app: App,
  email: string,
  role?: 'admin',
): Promise<TokenBody> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/dev-token',
    payload: role ? { email, role } : { email },
  });
  return res.json() as TokenBody;
}

describe('admin queue endpoints', () => {
  let app: App;
  let adminToken: string;
  let userToken: string;
  let userId: string;
  const adminEmail = `admin+${Date.now()}@test.local`;
  const userEmail = `regular+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    const adminBody = await getToken(app, adminEmail, 'admin');
    adminToken = adminBody.token;
    expect(adminBody.user.role).toBe('admin');

    const userBody = await getToken(app, userEmail);
    userToken = userBody.token;
    userId = userBody.user.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { in: [adminEmail, userEmail] } },
    });
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

  describe('auth gating', () => {
    test('GET /admin/queue/stats requires a token (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/queue/stats',
      });
      expect(res.statusCode).toBe(401);
    });

    test('GET /admin/queue/stats rejects a non-admin token (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/queue/stats',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    test('admin token gets through', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/queue/stats',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  test('queue stats reflects jobs added to each queue', async () => {
    // Seed a real waiting job on the websocket queue and a fake DLQ entry.
    await websocketQueue.add('websocket', {
      notificationId: 'noop',
      userId,
      channel: 'websocket',
      payload: {},
    });
    await deadLetterQueue.add('websocket', {
      notificationId: 'noop',
      userId,
      channel: 'websocket',
      payload: {},
      reason: 'seeded for the test',
      failedAt: new Date().toISOString(),
      originalJobId: 'never-existed',
      attemptsMade: 5,
    } satisfies DeadLetterJobData);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/queue/stats',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      websocket: { waiting: number };
      email: { waiting: number };
      dlq: { waiting: number };
    };
    expect(body.websocket.waiting).toBeGreaterThanOrEqual(1);
    expect(body.dlq.waiting).toBeGreaterThanOrEqual(1);
    expect(body.email.waiting).toBe(0);
  });

  test('GET /admin/queue/dlq lists DLQ entries with the failure reason', async () => {
    const notif = await prisma.notification.create({
      data: {
        userId,
        type: 'fail',
        channel: 'websocket',
        payload: { x: 1 },
        status: 'DEAD_LETTER',
      },
    });
    await deadLetterQueue.add('websocket', {
      notificationId: notif.id,
      userId,
      channel: 'websocket',
      payload: { x: 1 },
      reason: 'recipient has no active connections',
      failedAt: new Date().toISOString(),
      originalJobId: 'orig-1',
      attemptsMade: 5,
    } satisfies DeadLetterJobData);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/queue/dlq',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        notificationId: string;
        reason: string;
        attemptsMade: number;
      }>;
    };
    const found = body.items.find((j) => j.notificationId === notif.id);
    expect(found).toBeDefined();
    expect(found?.reason).toBe('recipient has no active connections');
    expect(found?.attemptsMade).toBe(5);
  });

  test('POST /admin/queue/dlq/:jobId/retry requeues the job and resets the row', async () => {
    const notif = await prisma.notification.create({
      data: {
        userId,
        type: 'retry-me',
        channel: 'websocket',
        payload: { hello: 'world' },
        status: 'DEAD_LETTER',
        attempts: 5,
        lastError: 'recipient has no active connections',
      },
    });
    const dlqJob = await deadLetterQueue.add('websocket', {
      notificationId: notif.id,
      userId,
      channel: 'websocket',
      payload: { hello: 'world' },
      reason: 'recipient has no active connections',
      failedAt: new Date().toISOString(),
      originalJobId: 'orig-2',
      attemptsMade: 5,
    } satisfies DeadLetterJobData);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/queue/dlq/${dlqJob.id}/retry`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      retried: boolean;
      newJobId: string;
      notificationId: string;
    };
    expect(body.retried).toBe(true);
    expect(body.notificationId).toBe(notif.id);

    // The DLQ entry is gone…
    const stillThere = await deadLetterQueue.getJob(dlqJob.id!);
    expect(stillThere).toBeUndefined();

    // …a fresh job is on the websocket queue…
    const waiting = await websocketQueue.getJobs(['waiting']);
    const matching = waiting.filter(
      (j) => (j.data as { notificationId?: string }).notificationId === notif.id,
    );
    expect(matching).toHaveLength(1);

    // …and the row is back to QUEUED with attempts cleared.
    const row = await prisma.notification.findUnique({
      where: { id: notif.id },
    });
    expect(row?.status).toBe('QUEUED');
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
  });

  test('retry on a missing DLQ job returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/queue/dlq/does-not-exist/retry',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
