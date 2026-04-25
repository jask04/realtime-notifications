import type { FastifyPluginAsync } from 'fastify';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { add as registerSocket, remove as deregisterSocket } from './registry.js';

// What the JWT decodes into. Must match the payload signed in routes/auth.ts.
interface JwtPayload {
  id: string;
  email: string;
}

// Anything we hang off `socket.data` is typed by this so the worker (Day 7)
// can read `socket.data.userId` without casting.
declare module 'socket.io' {
  interface SocketData {
    userId: string;
    email: string;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer;
  }
}

// Module-level reference so non-Fastify code (the BullMQ worker) can grab
// the active io instance without threading the Fastify app through every
// call site.
//
// This is single-process glue: it works because the worker runs in the same
// Node process as the API. Day 13 replaces it with the Socket.io Redis
// adapter so workers running in a separate process can fan out to API
// instances over Redis pub/sub.
let activeIo: SocketIOServer | null = null;

export function getIo(): SocketIOServer {
  if (!activeIo) {
    throw new Error(
      'Socket.io has not been initialized — register websocketPlugin first',
    );
  }
  return activeIo;
}

/**
 * Attach a Socket.io server to the same HTTP server Fastify is using and
 * decorate the app with `app.io`.
 *
 * Auth happens during the WebSocket handshake: clients send their JWT in
 * `auth.token` (the canonical socket.io-client way) or `?token=` query
 * (so the static debug page can connect from a browser without scripting
 * the auth payload). Bad/missing tokens are rejected before `connection`
 * fires — handlers downstream can trust `socket.data.userId` exists.
 *
 * Registered as a Fastify plugin so the FastifyInstance type generic
 * (Pino logger) lines up cleanly at the call site.
 */
export const websocketPlugin: FastifyPluginAsync = async (app) => {
  const io = new SocketIOServer(app.server, {
    // CORS is permissive in dev for the same reasons as the HTTP CORS
    // plugin — tighten this when we have a real frontend domain.
    cors: { origin: true, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next(new Error('Missing auth token'));
      }
      const payload = app.jwt.verify<JwtPayload>(token);
      socket.data.userId = payload.id;
      socket.data.email = payload.email;
      return next();
    } catch {
      return next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    registerSocket(userId, socket.id);
    app.log.debug({ userId, socketId: socket.id }, 'ws connected');

    // Echoed back to the client so a browser can confirm the handshake
    // round-tripped (and so the integration test has something to await).
    socket.emit('connected', { userId });

    socket.on('disconnect', (reason) => {
      deregisterSocket(socket.id);
      app.log.debug(
        { userId, socketId: socket.id, reason },
        'ws disconnected',
      );
    });
  });

  app.decorate('io', io);
  activeIo = io;

  // Make sure `app.close()` tears the io down too — otherwise Vitest hangs
  // on open sockets at the end of a test run.
  app.addHook('onClose', async () => {
    await io.close();
    activeIo = null;
  });
};

function extractToken(socket: Socket): string | undefined {
  // Preferred: socket.io-client's `auth: { token }` channel.
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)
    ?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  // Fallback: ?token=... in the URL, used by the static debug page.
  const fromQuery = socket.handshake.query.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return undefined;
}
