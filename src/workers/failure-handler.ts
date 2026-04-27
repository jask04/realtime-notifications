import type { Job, Worker } from 'bullmq';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import type { NotificationJobData } from '../queue/notifications.js';
import { moveToDLQ } from '../queue/deadletter.js';

/**
 * Wire up the standard "what to do when a job fails" behaviour onto a
 * BullMQ worker.
 *
 * - Mid-flight failures (BullMQ will retry): record `attempts` and the
 *   error message on the row so an operator can see what's happening
 *   without grepping BullMQ.
 * - Final failures (retries exhausted, or the handler threw an
 *   `UnrecoverableError` to opt out of retrying): flip the row to
 *   DEAD_LETTER and copy the job into the dead-letter queue for manual
 *   review.
 *
 * Every failure path swallows secondary errors — if the DB or DLQ write
 * fails, log it but don't take down the worker. Losing visibility on a
 * single failure is much better than losing the worker entirely.
 */
export function attachFailureHandler(
  worker: Worker<NotificationJobData>,
): void {
  worker.on('failed', async (job, err) => {
    if (!job) return;
    const isUnrecoverable = err.name === 'UnrecoverableError';
    const isFinalAttempt =
      isUnrecoverable ||
      (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1);

    if (isFinalAttempt) {
      await markDeadLetter(job, err.message);
      try {
        await moveToDLQ(job, err.message);
      } catch (dlqErr) {
        logger.error({ err: dlqErr }, 'failed to move job to DLQ');
      }
      logger.warn(
        {
          notificationId: job.data.notificationId,
          channel: job.data.channel,
          attempts: job.attemptsMade,
          reason: err.message,
        },
        'notification dead-lettered',
      );
    } else {
      try {
        await prisma.notification.update({
          where: { id: job.data.notificationId },
          data: { attempts: job.attemptsMade, lastError: err.message },
        });
      } catch (dbErr) {
        logger.error({ err: dbErr }, 'failed to record retry progress');
      }
    }
  });

  worker.on('error', (err) => {
    logger.error({ err, queue: worker.name }, 'worker error');
  });
}

async function markDeadLetter(
  job: Job<NotificationJobData>,
  reason: string,
): Promise<void> {
  try {
    await prisma.notification.update({
      where: { id: job.data.notificationId },
      data: {
        status: 'DEAD_LETTER',
        attempts: job.attemptsMade,
        lastError: reason,
      },
    });
  } catch (dbErr) {
    logger.error({ err: dbErr }, 'failed to mark notification DEAD_LETTER');
  }
}
