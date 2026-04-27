import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { prisma } from '../db/client.js';
import { redis } from '../queue/connection.js';
import {
  WEBSOCKET_QUEUE,
  type NotificationJobData,
} from '../queue/notifications.js';
import { getSockets } from '../ws/registry.js';
import { getIo } from '../ws/server.js';
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
 * - "Notification row missing" throws an UnrecoverableError because no
 *   amount of retrying will bring it back — straight to DLQ.
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

  const sockets = getSockets(userId);
  if (sockets.length === 0) {
    throw new Error(RECIPIENT_OFFLINE);
  }

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) {
    // The row was rolled back or deleted out from under us. Retrying won't
    // bring it back, so opt out of the retry budget.
    throw new UnrecoverableError(
      `notification ${notificationId} no longer exists`,
    );
  }

  const io = getIo();
  for (const socketId of sockets) {
    io.to(socketId).emit('notification', {
      id: notification.id,
      type: notification.type,
      payload,
      createdAt: notification.createdAt.toISOString(),
    });
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'SENT', deliveredAt: new Date() },
  });
}
