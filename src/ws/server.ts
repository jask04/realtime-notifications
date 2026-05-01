import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { redis } from '../queue/connection.js';
import { add as registerSocket, remove as deregisterSocket } from './registry.js';

// What the JWT decodes into. Must match the payload signed in routes/auth.ts.
interface JwtPayload {
  id: string;
  email: string;
}

// Anything we hang off `socket.data` is typed by this so the worker
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
// call site. With the Redis adapter installed below, a worker in a
// separate process could in principle build its own io and emit through
// Redis — but in this codebase the worker still runs in-process, so
// reading the local io is enough.
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
 * The Redis adapter makes `io.to(socketId).emit(...)` route across every
 * API instance: each Fastify pod attaches its io to the same pub/sub
 * channels, so a notification queued on node A can be delivered to a
 * socket connected to node B. Without the adapter, the local io has no
 * idea node B's sockets exist and the emit silently no-ops on a different
 * machine.
 *
 * Registered as a Fastify plugin so the FastifyInstance type generic
 * (Pino logger) lines up cleanly at the call site.
 */
const websocketPluginImpl: FastifyPluginAsync = async (app) => {
  const io = new SocketIOServer(app.server, {
    // CORS is permissive in dev for the same reasons as the HTTP CORS
    // plugin — tighten this when we have a real frontend domain.
    cors: { origin: true, credentials: true },
  });

  // Redis pub/sub for cross-instance delivery. The subscribe-mode client
  // can't run regular commands, so it has to be a separate connection
  // from the publish client and from the queue's main connection. We
  // duplicate the queue's options (host, port, password, etc.) rather
  // than re-reading config so the adapter automatically follows any
  // future changes to the connection setup.
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

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

  // Make sure `app.close()` tears the io and the adapter clients down too
  // — otherwise Vitest hangs on open sockets at the end of a test run.
  app.addHook('onClose', async () => {
    await io.close();
    // Only nil the singleton if we still own it. If a second app was
    // registered after this one (multi-node test), it overwrote
    // `activeIo` and we shouldn't clobber its reference here.
    if (activeIo === io) {
      activeIo = null;
    }
    await Promise.all([
      pubClient.quit().catch(() => {}),
      subClient.quit().catch(() => {}),
    ]);
  });
};

// Wrap with fastify-plugin so the `io` decoration and the onClose hook
// escape the plugin's encapsulation scope. Without this, callers (and the
// multi-node test) wouldn't see `app.io` on the outer instance.
export const websocketPlugin = fp(websocketPluginImpl, {
  name: 'websocket',
});

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
