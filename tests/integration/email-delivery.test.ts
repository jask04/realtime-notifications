import type { Worker } from 'bullmq';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  enqueueNotification,
  emailQueue,
  notificationQueues,
} from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';
import { startWorkers, stopWorkers } from '../../src/workers/index.js';

// Hoist the mock so it's installed before the worker imports the mailer.
// `vi.hoisted` keeps a reference accessible from the test body.
const { sendMailMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn().mockResolvedValue({ messageId: 'fake' }),
}));

vi.mock('../../src/lib/mailer.js', () => ({
  getMailer: () => ({ sendMail: sendMailMock }),
  __setMailerForTesting: () => {},
}));

type App = Awaited<ReturnType<typeof createApp>>;

interface TokenBody {
  token: string;
  user: { id: string; email: string };
}

describe('email delivery worker', () => {
  let app: App;
  let token: string;
  let userId: string;
  let userEmail: string;
  let workers: Worker[];
  const email = `email-delivery+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    // Earlier test files can leave jobs whose database fixtures are gone.
    // Clear those jobs before workers can race this suite's setup.
    await Promise.all(
      notificationQueues.map((q) => q.obliterate({ force: true })),
    );
    await deadLetterQueue.obliterate({ force: true });
    workers = await startWorkers();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });
    const body = res.json() as TokenBody;
    token = body.token;
    userId = body.user.id;
    userEmail = body.user.email;
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
    await Promise.all(workers.map((w) => w.pause()));
    await Promise.all(
      notificationQueues.map((q) => q.obliterate({ force: true })),
    );
    await deadLetterQueue.obliterate({ force: true });
    await prisma.notification.deleteMany({ where: { userId } });
    sendMailMock.mockClear();
    await Promise.all(workers.map((w) => w.resume()));
  });

  test('deleted notification: no SMTP send, job lands in DLQ', async () => {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: 'deleted',
        channel: 'email',
        payload: { subject: 'must not send', html: '<p>deleted</p>' },
      },
    });
    await prisma.notification.delete({ where: { id: notification.id } });
    await enqueueNotification(
      {
        notificationId: notification.id,
        userId,
        channel: 'email',
        payload: { subject: 'must not send', html: '<p>deleted</p>' },
      },
      { attempts: 1, backoff: undefined },
    );

    await vi.waitFor(
      async () => {
        const jobs = await deadLetterQueue.getJobs(['waiting']);
        const job = jobs.find((j) => j.data.notificationId === notification.id);
        expect(job?.data.reason).toMatch(/notification .* no longer exists/);
      },
      { timeout: 3000 },
    );
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  test('replayed job for a SENT notification does not send again', async () => {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: 'already-sent',
        channel: 'email',
        status: 'SENT',
        deliveredAt: new Date(),
        payload: { subject: 'already sent', html: '<p>sent</p>' },
      },
    });
    const jobId = await enqueueNotification({
      notificationId: notification.id,
      userId,
      channel: 'email',
      payload: { subject: 'already sent', html: '<p>sent</p>' },
    });
    await vi.waitFor(
      async () => {
        expect(await (await emailQueue.getJob(jobId))?.getState()).toBe(
          'completed',
        );
      },
      { timeout: 3000 },
    );
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  test('valid email payload: nodemailer is called and DB flips to SENT', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId,
        type: 'welcome',
        channel: 'email',
        payload: {
          subject: 'Welcome aboard',
          html: '<p>Glad you signed up.</p>',
        },
      },
    });
    expect(postRes.statusCode).toBe(201);
    const { notification } = postRes.json() as {
      notification: { id: string };
    };

    // Wait for the worker to drain and update the DB.
    const deadline = Date.now() + 3000;
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

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const args = sendMailMock.mock.calls[0]?.[0];
    expect(args.to).toBe(userEmail);
    expect(args.subject).toBe('Welcome aboard');
    // The worker wraps the inner body with the HTML template, so the sent
    // html should both contain the original snippet and the doctype shell.
    expect(args.html).toContain('<!doctype html>');
    expect(args.html).toContain('<p>Glad you signed up.</p>');
    expect(args.from).toMatch(/.+@.+/);
  });

  test('invalid email payload: never calls nodemailer, lands in DLQ', async () => {
    // Bypass the API since the route doesn't (yet) validate channel-specific
    // payloads — that's the worker's job. Enqueue with attempts:1 so the
    // failed-handler runs immediately.
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: 'welcome',
        channel: 'email',
        // Missing subject/html — Zod in the worker should reject this.
        payload: { unrelated: 'data' },
      },
    });

    await enqueueNotification(
      {
        notificationId: notification.id,
        userId,
        channel: 'email',
        payload: { unrelated: 'data' },
      },
      { attempts: 1, backoff: undefined },
    );

    const deadline = Date.now() + 3000;
    let row = await prisma.notification.findUnique({
      where: { id: notification.id },
    });
    while (row && row.status !== 'DEAD_LETTER' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      row = await prisma.notification.findUnique({
        where: { id: notification.id },
      });
    }
    expect(row?.status).toBe('DEAD_LETTER');
    expect(row?.lastError).toMatch(/invalid email payload/i);
    expect(sendMailMock).not.toHaveBeenCalled();

    const dlqJobs = await deadLetterQueue.getJobs(['waiting']);
    const matching = dlqJobs.filter(
      (j) => j.data.notificationId === notification.id,
    );
    expect(matching).toHaveLength(1);
  });

  test('valid payload but unknown recipient: unrecoverable, no SMTP send, DLQ', async () => {
    // Recipient row never exists in DB.
    const fakeNotificationId = 'cmoffake0000000000000fake0';
    await prisma.notification.create({
      data: {
        id: fakeNotificationId,
        userId,
        type: 'welcome',
        channel: 'email',
        payload: { subject: 'hi', html: '<p>hi</p>' },
      },
    });

    await enqueueNotification(
      {
        notificationId: fakeNotificationId,
        userId: 'this-user-does-not-exist',
        channel: 'email',
        payload: { subject: 'hi', html: '<p>hi</p>' },
      },
      { attempts: 1, backoff: undefined },
    );

    const deadline = Date.now() + 3000;
    let row = await prisma.notification.findUnique({
      where: { id: fakeNotificationId },
    });
    while (row && row.status !== 'DEAD_LETTER' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      row = await prisma.notification.findUnique({
        where: { id: fakeNotificationId },
      });
    }
    expect(row?.status).toBe('DEAD_LETTER');
    expect(row?.lastError).toMatch(/no longer exists/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
