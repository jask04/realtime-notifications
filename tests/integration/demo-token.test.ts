import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import { notificationQueues } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string; role?: string };
  expiresIn: string;
}

describe('POST /auth/demo-token', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    // Sweep up every demo user this suite created. The email pattern is
    // unique enough that we can target it without touching anything else.
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'demo+' } },
    });
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('returns a token, user with role=demo, and an expiresIn hint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/demo-token',
      // Unique per-test fake IP so rate-limiter buckets don't collide
      // across test cases. trustProxy=true makes Fastify trust this.
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TokenBody;
    expect(body.token).toBeTypeOf('string');
    expect(body.user.role).toBe('demo');
    expect(body.user.email).toMatch(/^demo\+[a-f0-9]+@demo\.local$/);
    expect(body.user.id).toBeTypeOf('string');
    expect(body.expiresIn).toBe('1h');
  });

  test('the token decodes with role=demo and a 1h-ish expiry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/demo-token',
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });
    const { token } = res.json() as TokenBody;
    const decoded = app.jwt.verify<{
      id: string;
      email: string;
      role?: string;
      iat: number;
      exp: number;
    }>(token);
    expect(decoded.role).toBe('demo');
    const lifespanSeconds = decoded.exp - decoded.iat;
    // Allow a tiny rounding window — should be exactly 3600 in practice.
    expect(lifespanSeconds).toBeGreaterThanOrEqual(3590);
    expect(lifespanSeconds).toBeLessThanOrEqual(3610);
  });

  test('rate-limits a single IP after 5 requests', async () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/demo-token',
        headers: { 'x-forwarded-for': ip },
      });
      expect(res.statusCode).toBe(200);
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/auth/demo-token',
      headers: { 'x-forwarded-for': ip },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  test('demo tokens cannot use /notifications/fanout (403)', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/auth/demo-token',
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    const { token, user } = tokenRes.json() as TokenBody;

    const fanoutRes = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: [user.id],
        type: 'noop',
        channel: 'websocket',
        payload: { title: 'should not get through' },
      },
    });
    expect(fanoutRes.statusCode).toBe(403);
    const body = fanoutRes.json() as { error: string };
    expect(body.error).toMatch(/demo/i);
  });

  test('demo tokens can use POST /notifications (the demo flow)', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/auth/demo-token',
      headers: { 'x-forwarded-for': '203.0.113.30' },
    });
    const { token, user } = tokenRes.json() as TokenBody;

    const postRes = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: user.id,
        type: 'demo',
        channel: 'websocket',
        payload: { title: 'Hello demo' },
      },
    });
    expect(postRes.statusCode).toBe(201);
  });
});
