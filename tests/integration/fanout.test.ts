import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  notificationQueues,
  queueForChannel,
} from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

interface FanoutResponse {
  enqueued: number;
  skipped: { userId: string; reason: string }[];
}

describe('POST /notifications/fanout', () => {
  let app: App;
  let token: string;
  const callerEmail = `fanout-caller+${Date.now()}@test.local`;
  const recipientEmails: string[] = [];

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
      where: { email: { in: [callerEmail, ...recipientEmails] } },
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
  });

  async function createRecipients(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const e = `fanout-r+${Date.now()}-${i}-${Math.random()}@test.local`;
      const u = await prisma.user.create({ data: { email: e } });
      recipientEmails.push(e);
      ids.push(u.id);
    }
    return ids;
  }

  test('returns 401 without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      payload: {
        userIds: ['anything'],
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test('creates one row + one job per recipient', async () => {
    const ids = await createRecipients(5);

    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: ids,
        type: 'broadcast',
        channel: 'websocket',
        payload: { headline: 'all hands at 3' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FanoutResponse;
    expect(body.enqueued).toBe(5);
    expect(body.skipped).toHaveLength(0);

    const rows = await prisma.notification.findMany({
      where: { userId: { in: ids }, type: 'broadcast' },
    });
    expect(rows).toHaveLength(5);
    rows.forEach((r) => expect(r.status).toBe('QUEUED'));

    const waiting = await queueForChannel('websocket').getJobs(['waiting']);
    const matching = waiting.filter((j) =>
      ids.includes((j.data as { userId: string }).userId),
    );
    expect(matching).toHaveLength(5);
  });

  test('idempotencyKey suffixing dedupes per recipient on replay', async () => {
    const ids = await createRecipients(3);
    const idempotencyKey = `digest-${Date.now()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: ids,
        type: 'digest',
        channel: 'websocket',
        payload: {},
        idempotencyKey,
      },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as FanoutResponse).enqueued).toBe(3);

    // Replay with the same key — every recipient already has a row, so all
    // get skipped as idempotent replays.
    const second = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: ids,
        type: 'digest',
        channel: 'websocket',
        payload: {},
        idempotencyKey,
      },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as FanoutResponse;
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toHaveLength(3);
    body.skipped.forEach((s) => expect(s.reason).toMatch(/idempotent/i));

    // And only one row per recipient exists.
    const rows = await prisma.notification.findMany({
      where: { userId: { in: ids }, type: 'digest' },
    });
    expect(rows).toHaveLength(3);
  });

  test('mix of valid and unknown userIds: skipped breakdown', async () => {
    const valid = await createRecipients(2);
    const userIds = [...valid, 'this-user-does-not-exist'];

    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds,
        type: 'mixed',
        channel: 'websocket',
        payload: {},
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FanoutResponse;
    expect(body.enqueued).toBe(2);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]?.userId).toBe('this-user-does-not-exist');
    expect(body.skipped[0]?.reason).toMatch(/does not exist/i);
  });

  test('duplicate userIds in the request are coalesced', async () => {
    const ids = await createRecipients(2);
    // Pass the second user twice.
    const userIds = [ids[0]!, ids[1]!, ids[1]!];

    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds,
        type: 'dedupe-test',
        channel: 'websocket',
        payload: {},
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FanoutResponse;
    expect(body.enqueued).toBe(2);

    const rows = await prisma.notification.findMany({
      where: { userId: { in: ids }, type: 'dedupe-test' },
    });
    expect(rows).toHaveLength(2);
  });

  test('rejects empty userIds array with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: [],
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects more than 1000 userIds with 400', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `u${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/fanout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userIds: tooMany,
        type: 't',
        channel: 'websocket',
        payload: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
