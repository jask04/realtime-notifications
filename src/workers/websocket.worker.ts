import { Worker, type Job } from 'bullmq';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { redis } from '../queue/connection.js';
import {
  NOTIFICATIONS_QUEUE,
  type NotificationJobData,
} from '../queue/notifications.js';
import { moveToDLQ } from '../queue/deadletter.js';
import { getSockets } from '../ws/registry.js';
import { getIo } from '../ws/server.js';

// Sentinel reasons so the failed-handler can distinguish "user is offline"
// (worth retrying — they might come back online) from "the work itself is
// broken" (no point retrying further).
export const RECIPIENT_OFFLINE = 'recipient has no active connections';

/**
 * BullMQ worker that drains the notifications queue and pushes the row to
 * any sockets the recipient has open.
 *
 * Day-7 design notes:
 * - Single queue, single worker. Day 8 introduces an email worker; the two
 *   would currently compete on the same queue (BullMQ workers are pull-based
 *   and don't filter by job name), so until we split the queue per channel
 *   the websocket worker no-ops on non-websocket jobs to avoid swallowing
 *   email work that another worker should pick up.
 * - DB writes happen after the emit, not before. If the emit throws, we
 *   leave the row in QUEUED so a retry can try again; we don't want a SENT
 *   row that wasn't actually sent.
 * - Offline recipients throw a sentinel error; BullMQ retries it under
 *   exponential backoff (configured at enqueue time). After attempts are
 *   exhausted, the failed-handler moves the job to the DLQ and flips the
 *   notification row to DEAD_LETTER.
 */
export function createWebsocketWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(
    NOTIFICATIONS_QUEUE,
    handleJob,
    {
      connection: redis,
      // Light concurrency — generous for dev, easy to bump in production.
      concurrency: 10,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const isFinalAttempt =
      (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      try {
        await prisma.notification.update({
          where: { id: job.data.notificationId },
          data: {
            status: 'DEAD_LETTER',
            attempts: job.attemptsMade,
            lastError: err.message,
          },
        });
      } catch (dbErr) {
        logger.error({ err: dbErr }, 'failed to mark notification DEAD_LETTER');
      }
      try {
        await moveToDLQ(job, err.message);
      } catch (dlqErr) {
        logger.error({ err: dlqErr }, 'failed to move job to DLQ');
      }
      logger.warn(
        {
          notificationId: job.data.notificationId,
          attempts: job.attemptsMade,
          reason: err.message,
        },
        'notification dead-lettered',
      );
    } else {
      // Mid-flight failure — record progress so an operator looking at the
      // row sees what's going on without having to grep BullMQ.
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
    logger.error({ err }, 'websocket worker error');
  });

  return worker;
}

async function handleJob(job: Job<NotificationJobData>): Promise<void> {
  const { channel, userId, notificationId, payload } = job.data;

  // See "Day-7 design notes" above. When the email worker lands we'll split
  // the queue by channel and this branch goes away.
  if (channel !== 'websocket') {
    return;
  }

  const sockets = getSockets(userId);
  if (sockets.length === 0) {
    throw new Error(RECIPIENT_OFFLINE);
  }

  const io = getIo();

  // Look up `type` so the client gets a complete event without having to
  // call back to the API. The DB is the source of truth — the queue payload
  // is only the parts the worker absolutely needs.
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) {
    // Permanent failure: the row was rolled back or hand-deleted. Don't
    // retry — let it dead-letter.
    throw new Error(`notification ${notificationId} no longer exists`);
  }

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
