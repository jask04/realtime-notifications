import type { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { createWebsocketWorker } from './websocket.worker.js';

/**
 * Boot every delivery worker this process runs and return them so the
 * caller can close them on shutdown. Today there's only one worker
 * (websocket); Day 8 adds email.
 *
 * Workers live in the same process as the API for now — the websocket
 * worker reads from a module singleton populated by the Fastify plugin.
 * Day 13 splits the API and worker processes by switching to the
 * Socket.io Redis adapter for cross-process delivery.
 */
export function startWorkers(): Worker[] {
  const workers = [createWebsocketWorker()];
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
 * which boots the API + workers in a single process. Once Day 13 lands the
 * Redis adapter, this entrypoint can drop the API listen and run only the
 * workers.
 */
async function bootstrap(): Promise<void> {
  const { createApp } = await import('../app.js');
  const { config } = await import('../config.js');

  const app = await createApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  const workers = startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting workers down');
    await stopWorkers(workers);
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
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
