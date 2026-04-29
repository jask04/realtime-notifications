import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  deadLetterQueue,
  type DeadLetterJobData,
} from '../queue/deadletter.js';
import {
  enqueueNotification,
  notificationQueues,
  websocketQueue,
  emailQueue,
} from '../queue/notifications.js';

const dlqListQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

interface QueueSnapshot {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

async function snapshot(
  queue: (typeof notificationQueues)[number] | typeof deadLetterQueue,
): Promise<QueueSnapshot> {
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
  );
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  };
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Aggregate queue health — operator's first stop when something looks off.
  app.get(
    '/admin/queue/stats',
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const [websocket, email, dlq] = await Promise.all([
        snapshot(websocketQueue),
        snapshot(emailQueue),
        snapshot(deadLetterQueue),
      ]);
      return reply.send({ websocket, email, dlq });
    },
  );

  // Inspect the DLQ. Useful for understanding *why* deliveries are failing
  // before deciding whether to retry, fix the underlying issue, or drop them.
  app.get(
    '/admin/queue/dlq',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = dlqListQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid query',
          issues: parsed.error.flatten(),
        });
      }
      const { limit } = parsed.data;
      // getJobs is end-inclusive, so subtract 1 to honour `limit` exactly.
      const jobs = await deadLetterQueue.getJobs(
        ['waiting'],
        0,
        limit - 1,
        false,
      );
      const items = jobs.map((j) => ({
        id: j.id,
        notificationId: j.data.notificationId,
        userId: j.data.userId,
        channel: j.data.channel,
        reason: j.data.reason,
        failedAt: j.data.failedAt,
        attemptsMade: j.data.attemptsMade,
        originalJobId: j.data.originalJobId,
      }));
      return reply.send({ items });
    },
  );

  // Re-enqueue a dead-lettered job into its original channel queue. The
  // notification row's status flips from DEAD_LETTER back to QUEUED; the
  // attempts counter resets so the operator gets a fresh retry budget.
  app.post(
    '/admin/queue/dlq/:jobId/retry',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const job = await deadLetterQueue.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'DLQ job not found' });
      }

      const data = job.data as DeadLetterJobData;
      const newJobId = await enqueueNotification({
        notificationId: data.notificationId,
        userId: data.userId,
        channel: data.channel,
        payload: data.payload,
      });

      // Best-effort row update — if the notification was hard-deleted the
      // re-enqueued job will hit the worker's "row missing" path and DLQ
      // again. That's the right outcome.
      await prisma.notification
        .updateMany({
          where: { id: data.notificationId },
          data: {
            status: 'QUEUED',
            attempts: 0,
            lastError: null,
          },
        })
        .catch(() => {
          // Swallow — the re-enqueue itself is the source of truth here.
        });

      await job.remove();

      return reply.send({
        retried: true,
        originalJobId: data.originalJobId,
        newJobId,
        notificationId: data.notificationId,
      });
    },
  );
};
