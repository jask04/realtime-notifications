import { Queue } from 'bullmq';
import { redis } from './connection.js';

export const CLEANUP_QUEUE = 'cleanup';

// Stable id for the scheduler so re-running `scheduleCleanup()` (every
// boot) replaces in place instead of piling up duplicate schedules.
export const DEMO_CLEANUP_SCHEDULER_ID = 'demo-cleanup';

// Top of every hour — small enough to keep the user table tight, large
// enough that the DELETE is essentially free under any portfolio-grade
// load. Day 15's demo tokens last 1h, so by the 24h cutoff used in the
// worker any session minted off these rows is long dead.
export const CLEANUP_CRON_PATTERN = '0 * * * *';

// Empty by design — the worker reads everything it needs from `prisma`
// and `Date.now()`. The interface stays here so any future additions
// (e.g. cleanup of *specific* email patterns) have a typed home.
export type CleanupJobData = Record<string, never>;

export const cleanupQueue = new Queue<CleanupJobData>(CLEANUP_QUEUE, {
  connection: redis,
});

/**
 * Register the hourly cleanup schedule. Idempotent: BullMQ's job
 * scheduler API replaces by id, so calling this on every boot is safe
 * and won't pile up duplicates if multiple replicas race.
 */
export async function scheduleCleanup(): Promise<void> {
  await cleanupQueue.upsertJobScheduler(
    DEMO_CLEANUP_SCHEDULER_ID,
    { pattern: CLEANUP_CRON_PATTERN },
    {
      name: DEMO_CLEANUP_SCHEDULER_ID,
      data: {},
      opts: {
        // The cleanup is idempotent at the SQL level (deleteMany with a
        // cutoff). One attempt is plenty — the next hourly tick will
        // pick up anything we miss.
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    },
  );
}
