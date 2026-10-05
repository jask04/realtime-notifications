import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';
import { redis } from '../../src/queue/connection.js';
import { notificationQueues } from '../../src/queue/notifications.js';
import { deadLetterQueue } from '../../src/queue/deadletter.js';

// API-only replica: the test process owns the delivery worker. This keeps
// presence maps separate so a process-local lookup cannot pass by accident.
const app = await createApp();
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address() as AddressInfo;
process.send?.({ url: `http://127.0.0.1:${address.port}` });
process.once('message', async () => {
  await app.close();
  await Promise.all(notificationQueues.map((q) => q.close()));
  await deadLetterQueue.close();
  await prisma.$disconnect();
  await redis.quit();
  process.disconnect();
});
