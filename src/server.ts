import { createApp } from './app.js';
import { config } from './config.js';
import { startWorkers, stopWorkers } from './workers/index.js';

const app = await createApp();

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Boot the BullMQ workers in the same process as the API. Single-process
// today; Day 13 introduces the Socket.io Redis adapter and lets these run
// on a separate node.
const workers = startWorkers();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await stopWorkers(workers);
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
