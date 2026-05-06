import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db/client.js';
import { installGracefulShutdown } from './lib/shutdown.js';
import { cleanupQueue } from './queue/cleanup.js';
import { redis } from './queue/connection.js';
import { deadLetterQueue } from './queue/deadletter.js';
import { notificationQueues } from './queue/notifications.js';
import { startWorkers, stopWorkers } from './workers/index.js';

const app = await createApp();

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Boot the BullMQ workers in the same process as the API. The Socket.io
// Redis adapter is already wired up, so in principle these could run as a
// separate process; keeping them in-process for now because it's one less
// thing to orchestrate at the deploy level.
const workers = await startWorkers();

// Order matters:
//  1. Stop the HTTP server first so no new requests start mid-shutdown.
//  2. Drain the workers so any in-flight delivery attempt gets to write
//     its DB row before its Redis client closes underneath it.
//  3. Close the BullMQ queue handles next — they share the Redis client
//     but it's cleaner to release them before the connection itself.
//  4. Disconnect Prisma. The HTTP layer is already gone; nothing else
//     should be querying.
//  5. Quit Redis last — the workers and BullMQ queues both held references
//     to it.
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
