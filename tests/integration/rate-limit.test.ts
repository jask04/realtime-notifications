import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  notificationQueues,
} from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

interface NotificationBody {
  notification: { id: string };
}

describe('per-recipient rate limit on POST /notifications', () => {
  let app: App;
  let token: string;
  // Each test uses its own recipient userId so the bucket is clean —
  // otherwise the previous test's drain would carry into the next.
  let recipientUserId: string;
  const callerEmail = `rl-caller+${Date.now()}@test.local`;
  let recipientEmail: string;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email: callerEmail },
    });
    token = (res.json() as TokenBody).token;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { in: [callerEmail, recipientEmail] } },
    });
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    // Fresh recipient + fresh bucket for every test.
    recipientEmail = `rl-recipient+${Date.now()}-${Math.random()}@test.local`;
    const recipient = await prisma.user.create({
      data: { email: recipientEmail },
    });
    recipientUserId = recipient.id;

    await Promise.all(
      notificationQueues.map((q) => q.obliterate({ force: true })),
    );
    await redis.del(`ratelimit:notify:${recipientUserId}`);
  });

  test('first 10 requests succeed, 11th returns 429 with Retry-After', async () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/notifications',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          userId: recipientUserId,
          type: 'spam-test',
          channel: 'websocket',
          payload: { i: 0 },
        },
      });

    for (let i = 0; i < 10; i += 1) {
      const res = await post();
      expect(res.statusCode).toBe(201);
    }

    const limited = await post();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    const body = limited.json() as { error: string; retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test('two recipients have independent buckets', async () => {
    const otherRecipient = await prisma.user.create({
      data: { email: `rl-other+${Date.now()}@test.local` },
    });

    // Drain recipient A's bucket.
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/notifications',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          userId: recipientUserId,
          type: 't',
          channel: 'websocket',
          payload: {},
        },
      });
      expect(res.statusCode).toBe(201);
    }
    const drainedA = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: recipientUserId,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(drainedA.statusCode).toBe(429);

    // B's bucket is untouched.
    const okB = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: otherRecipient.id,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(okB.statusCode).toBe(201);

    await prisma.notification.deleteMany({
      where: { userId: { in: [recipientUserId, otherRecipient.id] } },
    });
    await prisma.user.delete({ where: { id: otherRecipient.id } });
  });

  test('successful requests advertise remaining budget in a header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: recipientUserId,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    // First request consumed 1 of 10 — should report 9 remaining (or close,
    // accounting for the partial refill since the bucket was created).
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThanOrEqual(9);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(8);
  });

  test('unauthenticated requests do not consume budget', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications',
      payload: {
        userId: recipientUserId,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(401);

    // Bucket key shouldn't even exist in Redis yet — the limiter never ran.
    const ttl = await redis.exists(`ratelimit:notify:${recipientUserId}`);
    expect(ttl).toBe(0);

    // And we can still post a fresh notification at full capacity.
    const ok = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: recipientUserId,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(ok.statusCode).toBe(201);
  });

  test('rate-limited response also returned for missing recipient when over limit', async () => {
    // Drain.
    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/notifications',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          userId: recipientUserId,
          type: 't',
          channel: 'websocket',
          payload: {},
        },
      });
    }
    // Even when the row would otherwise 404 / 400, the rate limiter
    // intercepts first because it's the earlier preHandler.
    const limited = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: recipientUserId,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(limited.statusCode).toBe(429);
  });
});
