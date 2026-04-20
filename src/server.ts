import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config } from './config.js';
import { logger } from './lib/logger.js';

const app = Fastify({ loggerInstance: logger });

await app.register(helmet);
await app.register(cors, { origin: true });

app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
