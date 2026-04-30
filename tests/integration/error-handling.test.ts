import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import { notificationQueues } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

describe('error handler + request correlation', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp();
    // Test-only routes that exercise the error handler. They live on the
    // app instance for this suite's lifetime and don't pollute the real
    // surface area.
    app.get('/__test__/throw', async () => {
      throw new Error('synthetic failure with secret=hunter2');
    });
    app.get('/__test__/throw-with-status', async () => {
      const err = new Error('teapot') as Error & { statusCode?: number };
      err.statusCode = 418;
      throw err;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Promise.all(notificationQueues.map((q) => q.close()));
    await deadLetterQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('every response carries an x-request-id header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTypeOf('string');
    expect(String(res.headers['x-request-id']).length).toBeGreaterThan(0);
  });

  test('inbound x-request-id is echoed back so a load balancer correlation id wins', async () => {
    const incoming = 'corr-12345';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': incoming },
    });
    expect(res.headers['x-request-id']).toBe(incoming);
  });

  test('5xx response is sanitized: no stack, no original message, includes requestId', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test__/throw' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string; requestId: string };
    expect(body.error).toBe('Internal server error');
    expect(body.requestId).toBe(res.headers['x-request-id']);
    // The original message must not leak — it could contain DB column
    // names, file paths, or (as in the test fixture) credentials.
    expect(JSON.stringify(body)).not.toMatch(/hunter2/);
    expect(JSON.stringify(body)).not.toMatch(/synthetic failure/);
  });

  test('4xx errors thrown from a handler pass their message through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test__/throw-with-status',
    });
    expect(res.statusCode).toBe(418);
    const body = res.json() as { error: string; requestId: string };
    expect(body.error).toBe('teapot');
    expect(body.requestId).toBeTypeOf('string');
  });

  test('unauthenticated request to a protected route returns 401 with the standard shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-request-id']).toBeTypeOf('string');
  });

  test('unknown route returns 404 with the requestId header set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/this-route-does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBeTypeOf('string');
  });
});
