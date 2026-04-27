import { Queue, type JobsOptions } from 'bullmq';
import { redis } from './connection.js';

export type NotificationChannel = 'websocket' | 'email';

export interface NotificationJobData {
  notificationId: string;
  userId: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
}

// One queue per delivery channel.
//
// Why split: BullMQ workers don't filter jobs by name — every worker on a
// queue competes for every job. With a single shared queue a slow email
// send could block a websocket push (and vice versa), and adding a second
// worker that filters on `channel` would silently drop the jobs that the
// "wrong" worker grabbed first.
//
// Splitting also lets each channel tune retries, concurrency, and rate
// limits independently — Day 9 onwards exercises that.
export const WEBSOCKET_QUEUE = 'notifications-websocket';
export const EMAIL_QUEUE = 'notifications-email';

export const websocketQueue = new Queue<NotificationJobData>(WEBSOCKET_QUEUE, {
  connection: redis,
});
export const emailQueue = new Queue<NotificationJobData>(EMAIL_QUEUE, {
  connection: redis,
});

// Iterable view used by tests/admin tooling that wants to operate on every
// channel (clear, count, close, etc.) without spelling them out.
export const notificationQueues = [websocketQueue, emailQueue] as const;

export function queueForChannel(
  channel: NotificationChannel,
): Queue<NotificationJobData> {
  return channel === 'websocket' ? websocketQueue : emailQueue;
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

export async function enqueueNotification(
  data: NotificationJobData,
  opts: JobsOptions = {},
): Promise<string> {
  const queue = queueForChannel(data.channel);
  const job = await queue.add(data.channel, data, {
    ...DEFAULT_JOB_OPTS,
    ...opts,
  });
  if (!job.id) {
    throw new Error('BullMQ did not assign a job id');
  }
  return job.id;
}
