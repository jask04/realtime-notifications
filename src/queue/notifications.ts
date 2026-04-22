import { Queue, type JobsOptions } from 'bullmq';
import { redis } from './connection.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

export type NotificationChannel = 'websocket' | 'email';

export interface NotificationJobData {
  notificationId: string;
  userId: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
}

// Defaults we want on every notification job.
// - 5 attempts with exponential backoff: transient failures (Redis blip,
//   SMTP timeout) should recover without operator intervention.
// - removeOnComplete bounded so Redis doesn't grow forever in steady state.
// - removeOnFail keeps more history than complete — failures are what you
//   actually want to inspect when something's wrong.
const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1000 },
};

export const notificationQueue = new Queue<NotificationJobData>(
  NOTIFICATIONS_QUEUE,
  { connection: redis },
);

export async function enqueueNotification(
  data: NotificationJobData,
  opts: JobsOptions = {},
): Promise<string> {
  const job = await notificationQueue.add(data.channel, data, {
    ...DEFAULT_JOB_OPTS,
    ...opts,
  });
  if (!job.id) {
    throw new Error('BullMQ did not assign a job id');
  }
  return job.id;
}
