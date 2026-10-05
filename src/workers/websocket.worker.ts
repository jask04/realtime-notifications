import { Worker, type Job } from 'bullmq';
import { prisma } from '../db/client.js';
import { redis } from '../queue/connection.js';
import {
  WEBSOCKET_QUEUE,
  type NotificationJobData,
} from '../queue/notifications.js';
import { getIo, userRoom } from '../ws/server.js';
import { attachFailureHandler } from './failure-handler.js';

// Sentinel reason so the failed-handler / DLQ entry shows a human-readable
// "why" instead of a stack trace.
export const RECIPIENT_OFFLINE = 'recipient has no active connections';

/**
 * BullMQ worker for the websocket queue. Picks up notifications enqueued
 * with channel='websocket' and pushes them to whichever sockets the
 * recipient currently has open.
 *
 * Design notes:
 * - DB writes happen after the emit. If the emit throws we leave the row
 *   in QUEUED so a retry can try again — we don't want a SENT row that
 *   wasn't actually delivered.
 * - Offline recipients throw `RECIPIENT_OFFLINE`, which BullMQ retries
 *   under the exponential backoff configured at enqueue time. After the
 *   retry budget is exhausted the failure handler DLQs the job.
 * - A missing row retries: a job can arrive before the API's database
 *   transaction commits. A deleted or rolled-back row exhausts retries.
 */
export function createWebsocketWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(WEBSOCKET_QUEUE, handleJob, {
    connection: redis,
    concurrency: 10,
  });

  attachFailureHandler(worker);
  return worker;
}

async function handleJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, notificationId, payload } = job.data;

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) {
    throw new Error(`notification ${notificationId} no longer exists`);
  }

  if (notification.status === 'SENT') return;

  const io = getIo();
  const room = userRoom(userId);
  // The Redis adapter queries every replica, including processes with no
  // local connections for this user.
  const sockets = await io.in(room).fetchSockets();
  if (sockets.length === 0) {
    throw new Error(RECIPIENT_OFFLINE);
  }

  io.to(room).emit('notification', {
    id: notification.id,
    type: notification.type,
    payload,
    createdAt: notification.createdAt.toISOString(),
  });

  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'SENT', deliveredAt: new Date() },
  });
}
