import type { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { scheduleCleanup } from '../queue/cleanup.js';
import { createCleanupWorker } from './cleanup.worker.js';
import { createEmailWorker } from './email.worker.js';
import { createWebsocketWorker } from './websocket.worker.js';

/**
 * Boot every worker this process runs and return them so the caller can
 * close them on shutdown.
 *
 * - One delivery worker per channel (websocket, email). They each own a
 *   dedicated queue — see `src/queue/notifications.ts` for why.
 * - One cleanup worker that drains the cron-driven `cleanup` queue.
 *
 * Workers live in the same process as the API. The websocket worker
 * reads `io` from a module singleton populated by the Fastify plugin.
 * The Socket.io Redis adapter is already wired up, so splitting workers
 * onto a separate process is a deploy change rather than a code change —
 * co-locating for now keeps the orchestration story simple.
 */
export async function startWorkers(): Promise<Worker[]> {
  const workers: Worker[] = [
    createWebsocketWorker(),
    createEmailWorker(),
    createCleanupWorker(),
  ];
  // Register the cron schedule. `upsertJobScheduler` is idempotent on its
  // id, so calling it on every boot (or from every replica) is safe.
  await scheduleCleanup();
  logger.info({ count: workers.length }, 'workers started');
  return workers;
}

export async function stopWorkers(workers: Worker[]): Promise<void> {
  // BullMQ's worker.close() drains in-flight jobs before resolving — that's
  // the behaviour we want on shutdown so we don't truncate a delivery.
  await Promise.all(workers.map((w) => w.close()));
}

/**
 * Standalone entrypoint. `npm run start:workers` runs this file directly,
 * which boots the API + workers in a single process. To run workers on
 * their own (a sensible split when scaling out), drop the `app.listen`
 * call and the `http` shutdown target — the Socket.io Redis adapter
 * handles cross-process delivery.
 */
async function bootstrap(): Promise<void> {
  const { createApp } = await import('../app.js');
  const { config } = await import('../config.js');
  const { prisma } = await import('../db/client.js');
  const { redis } = await import('../queue/connection.js');
  const { deadLetterQueue } = await import('../queue/deadletter.js');
  const { notificationQueues } = await import('../queue/notifications.js');
  const { cleanupQueue } = await import('../queue/cleanup.js');
  const { installGracefulShutdown } = await import('../lib/shutdown.js');

  const app = await createApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  const workers = await startWorkers();

  // Same close order as src/server.ts — see the comment there for why.
  installGracefulShutdown([
    { name: 'http', close: () => app.close() },
    { name: 'workers', close: () => stopWorkers(workers) },
    {
      name: 'queues',
      close: async () => {
        await Promise.all(notificationQueues.map((q) => q.close()));
        await deadLetterQueue.close();
        await cleanupQueue.close();
      },
    },
    { name: 'prisma', close: () => prisma.$disconnect() },
    {
      name: 'redis',
      close: async () => {
        await redis.quit();
      },
    },
  ]);
}

// Run only when invoked directly (not when imported by tests).
const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectInvocation) {
  bootstrap().catch((err) => {
    logger.error({ err }, 'worker bootstrap failed');
    process.exit(1);
  });
}
