import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import {
  CLEANUP_CRON_PATTERN,
  cleanupQueue,
  DEMO_CLEANUP_SCHEDULER_ID,
  scheduleCleanup,
} from '../../src/queue/cleanup.js';
import { runCleanup } from '../../src/workers/cleanup.worker.js';

const HOUR_MS = 60 * 60 * 1000;

describe('demo cleanup', () => {
  // Suffix shared by every fixture so cleanup of test data at the end is
  // a single targeted delete — no risk of nuking unrelated rows.
  const tag = `cleanup-test-${Date.now()}`;
  const oldDemoEmail = `demo+old-${tag}@demo.local`;
  const freshDemoEmail = `demo+fresh-${tag}@demo.local`;
  const realEmail = `real-${tag}@example.local`;

  beforeAll(async () => {
    // Reset the cleanup queue so leftover schedulers from a prior run
    // don't make the schedule-test ambiguous.
    await cleanupQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    // Whatever survived the cleanup logic, sweep here.
    await prisma.user.deleteMany({
      where: { email: { in: [oldDemoEmail, freshDemoEmail, realEmail] } },
    });
    await cleanupQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  test('runCleanup deletes demo users older than 24h and leaves fresh + non-demo alone', async () => {
    const oldDemo = await prisma.user.create({
      data: {
        email: oldDemoEmail,
        // 25 hours ago, comfortably past the 24h cutoff.
        createdAt: new Date(Date.now() - 25 * HOUR_MS),
      },
    });
    const freshDemo = await prisma.user.create({
      data: {
        email: freshDemoEmail,
        // 1 hour ago — within the cutoff.
        createdAt: new Date(Date.now() - 1 * HOUR_MS),
      },
    });
    const realUser = await prisma.user.create({
      data: { email: realEmail },
    });

    // Each user gets a notification so we can verify the cascade
    // separately from the user-row delete.
    await prisma.notification.create({
      data: {
        userId: oldDemo.id,
        type: 'greeting',
        channel: 'websocket',
        payload: { x: 1 },
      },
    });
    await prisma.notification.create({
      data: {
        userId: freshDemo.id,
        type: 'greeting',
        channel: 'websocket',
        payload: { x: 2 },
      },
    });

    const result = await runCleanup();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // Old demo user is gone — and so is their notification (cascade).
    expect(
      await prisma.user.findUnique({ where: { id: oldDemo.id } }),
    ).toBeNull();
    expect(
      await prisma.notification.findMany({ where: { userId: oldDemo.id } }),
    ).toHaveLength(0);

    // Fresh demo user (and notification) survive.
    expect(
      await prisma.user.findUnique({ where: { id: freshDemo.id } }),
    ).not.toBeNull();
    expect(
      await prisma.notification.findMany({ where: { userId: freshDemo.id } }),
    ).toHaveLength(1);

    // Non-demo user is never touched, no matter how old.
    expect(
      await prisma.user.findUnique({ where: { id: realUser.id } }),
    ).not.toBeNull();
  });

  test('runCleanup is a no-op when there is nothing to delete', async () => {
    // Fixtures from the previous test were already cleaned (old demo) or
    // are too fresh to qualify. Running again should report 0 deletions.
    const result = await runCleanup();
    expect(result.deleted).toBe(0);
  });

  test('scheduleCleanup registers a repeatable job with the configured cron pattern', async () => {
    await scheduleCleanup();

    // BullMQ exposes the scheduler id as `key` on the returned object.
    const schedulers = await cleanupQueue.getJobSchedulers();
    const ours = schedulers.find((s) => s.key === DEMO_CLEANUP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours?.pattern).toBe(CLEANUP_CRON_PATTERN);
  });

  test('scheduleCleanup is idempotent (calling twice is a no-op)', async () => {
    await scheduleCleanup();
    await scheduleCleanup();

    const schedulers = await cleanupQueue.getJobSchedulers();
    const matching = schedulers.filter(
      (s) => s.key === DEMO_CLEANUP_SCHEDULER_ID,
    );
    // Exactly one scheduler regardless of call count — this is the
    // property `upsertJobScheduler` is supposed to give us.
    expect(matching).toHaveLength(1);
  });
});
