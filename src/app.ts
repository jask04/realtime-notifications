import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string };
    user: { id: string; email: string };
  }
}

export async function createApp() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.JWT_SECRET });

  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

  await app.register(authRoutes);

  return app;
}
