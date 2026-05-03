import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import staticFiles from '@fastify/static';
import { config } from './config.js';
import { appErrorHandler } from './lib/error-handler.js';
import { logger } from './lib/logger.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { notificationRoutes } from './routes/notifications.js';
import { websocketPlugin } from './ws/server.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string; role?: 'admin' | 'demo' };
    user: { id: string; email: string; role?: 'admin' | 'demo' };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ lives next to src/, so go one level up from compiled or source dir.
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// CSP needs to allow the things our static pages actually use. Helmet's
// out-of-the-box default is `script-src 'self'`, which blocks both the
// inline scripts in `index.html` / `ws-test.html` AND the socket.io
// client we load from cdn.socket.io. The result is a totally silent
// breakage where the page renders but no JS runs.
//
// We override two directives:
//   - script-src: allow self, the CDN, and inline (used by both pages)
//   - connect-src: allow self plus ws/wss so the browser can open a
//     WebSocket back to this server
//
// In dev we just turn CSP off — easier to iterate without a stale header
// breaking things on every dependency change.
const HELMET_OPTS =
  config.NODE_ENV === 'production'
    ? {
        contentSecurityPolicy: {
          directives: {
            'script-src': [
              "'self'",
              "'unsafe-inline'",
              'https://cdn.socket.io',
            ],
            'connect-src': ["'self'", 'ws:', 'wss:'],
          },
        },
      }
    : { contentSecurityPolicy: false };

export async function createApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust X-Forwarded-* headers from the platform's edge proxy so
    // `request.ip` is the actual client and not the proxy. Required for
    // per-IP rate limiting to do anything useful behind Railway / any
    // reverse proxy.
    trustProxy: true,
    // Echo any inbound `x-request-id` so a load balancer's correlation id
    // wins over our auto-generated one. Falls back to Fastify's default
    // sequence when absent.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0) return incoming;
      return crypto.randomUUID();
    },
  });

  app.setErrorHandler(appErrorHandler);

  // Mirror the request id back so a caller can quote it when reporting
  // problems and we can grep it out of logs.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet, HELMET_OPTS);
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(staticFiles, {
    root: PUBLIC_DIR,
    prefix: '/',
    // Don't shadow the API routes' `reply.send(...)`. Static is for files only.
    decorateReply: false,
  });

  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

  await app.register(authRoutes);
  await app.register(notificationRoutes);
  await app.register(adminRoutes);
  await app.register(websocketPlugin);

  return app;
}
