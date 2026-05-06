import { Worker } from 'bullmq';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { redis } from '../queue/connection.js';
import { CLEANUP_QUEUE, type CleanupJobData } from '../queue/cleanup.js';

// Demo users (and their notifications, via cascade) are dropped after
// this many ms. 24h is well past the demo JWT's 1h expiry, so anything
// being deleted here is dead-session detritus.
export const DEMO_USER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete demo users older than the TTL. Their notifications cascade
 * via the `onDelete: Cascade` on `Notification.user`.
 *
 * Exposed separately from the worker so it can be unit-tested without
 * spinning up BullMQ.
 */
export async function runCleanup(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - DEMO_USER_TTL_MS);
  const result = await prisma.user.deleteMany({
    where: {
      email: { startsWith: 'demo+' },
      createdAt: { lt: cutoff },
    },
  });
  // Quiet most of the time — log only when there's something to report.
  // 23 hours out of 24 this is a no-op and we'd rather not pollute logs.
  if (result.count > 0) {
    logger.info({ deleted: result.count }, 'demo cleanup deleted rows');
  } else {
    logger.debug({ deleted: 0 }, 'demo cleanup ran (no rows to delete)');
  }
  return { deleted: result.count };
}

export function createCleanupWorker(): Worker<CleanupJobData> {
  const worker = new Worker<CleanupJobData>(
    CLEANUP_QUEUE,
    async () => {
      await runCleanup();
    },
    {
      connection: redis,
      // Single concurrency — we never want two cleanup tickers running
      // in parallel. The BullMQ scheduler already guarantees one fire
      // per pattern across replicas, but a defensive 1 here is cheap.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    // No DLQ for cleanup — the next hourly tick is the natural retry.
    logger.error({ err, jobId: job?.id }, 'cleanup job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'cleanup worker error');
  });
  return worker;
}
