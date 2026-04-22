import { Queue, type Job } from 'bullmq';
import { redis } from './connection.js';
import type { NotificationJobData } from './notifications.js';

export const DLQ_NAME = 'notifications-dlq';

export interface DeadLetterJobData extends NotificationJobData {
  reason: string;
  failedAt: string;
  originalJobId: string;
  attemptsMade: number;
}

export const deadLetterQueue = new Queue<DeadLetterJobData>(DLQ_NAME, {
  connection: redis,
});

/**
 * Move a failed notification job to the dead-letter queue for manual review.
 * Jobs end up here after BullMQ exhausts their retry budget; see the
 * worker's failed-handler for the caller.
 */
export async function moveToDLQ(
  job: Job<NotificationJobData>,
  reason: string,
): Promise<void> {
  if (!job.id) {
    throw new Error('cannot DLQ a job with no id');
  }
  await deadLetterQueue.add(
    job.name,
    {
      ...job.data,
      reason,
      failedAt: new Date().toISOString(),
      originalJobId: job.id,
      attemptsMade: job.attemptsMade,
    },
    // DLQ jobs are already exhausted — no more retries.
    { attempts: 1, removeOnComplete: false, removeOnFail: false },
  );
}
