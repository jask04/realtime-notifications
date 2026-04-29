import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

interface HistoryBody {
  items: Array<{
    id: string;
    status: string;
    channel: string;
    type: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

describe('GET /notifications', () => {
  let app: App;
  let token: string;
  let userId: string;
  // A second user — the one we *don't* want bleeding into the caller's history.
  let otherUserId: string;
  const email = `hist+${Date.now()}@test.local`;
  const otherEmail = `hist-other+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    await Promise.all(
      notificationQueues.map((q) => q.obliterate({ force: true })),
    );
    await deadLetterQueue.obliterate({ force: true });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });
    const body = res.json() as TokenBody;
    token = body.token;
    userId = body.user.id;

    const otherUser = await prisma.user.create({ data: { email: otherEmail } });
    otherUserId = otherUser.id;

    // Seed a deterministic history. Using direct DB writes (rather than the
    // POST endpoint) keeps the queue out of the picture and lets us pin
    // statuses for filter assertions.
    const now = Date.now();
    await prisma.notification.createMany({
      data: [
        // Three for the caller, mixed channel and status, evenly spaced so
        // the DESC sort is unambiguous.
        {
          userId,
          type: 'a',
          channel: 'websocket',
          payload: { i: 1 },
          status: 'SENT',
          createdAt: new Date(now - 3000),
        },
        {
          userId,
          type: 'b',
          channel: 'email',
          payload: { i: 2 },
          status: 'SENT',
          createdAt: new Date(now - 2000),
        },
        {
          userId,
          type: 'c',
          channel: 'websocket',
          payload: { i: 3 },
          status: 'DEAD_LETTER',
          createdAt: new Date(now - 1000),
        },
        // One for someone else — must never appear in the caller's results.
        {
          userId: otherUserId,
          type: 'leak-canary',
          channel: 'websocket',
          payload: { i: 99 },
          status: 'SENT',
          createdAt: new Date(now),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { userId: { in: [userId, otherUserId] } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [email, otherEmail] } },
    });
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/notifications' });
    expect(res.statusCode).toBe(401);
  });

  test('returns the caller\'s notifications in createdAt-DESC order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HistoryBody;
    expect(body.items.map((n) => n.type)).toEqual(['c', 'b', 'a']);
    expect(body.nextCursor).toBeNull();
  });

  test('does not leak other users\' notifications', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as HistoryBody;
    expect(body.items.find((n) => n.type === 'leak-canary')).toBeUndefined();
  });

  test('filters by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notifications?status=DEAD_LETTER',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as HistoryBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.type).toBe('c');
  });

  test('filters by channel', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notifications?channel=email',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as HistoryBody;
    expect(body.items.map((n) => n.type)).toEqual(['b']);
  });

  test('paginates: limit + cursor walks through all rows', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/notifications?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    const firstBody = first.json() as HistoryBody;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/notifications?limit=2&cursor=${firstBody.nextCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const secondBody = second.json() as HistoryBody;
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    // Together the two pages cover the full history without duplicates.
    const ids = [
      ...firstBody.items.map((n) => n.id),
      ...secondBody.items.map((n) => n.id),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  test('rejects an unknown status with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notifications?status=NEAT',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
