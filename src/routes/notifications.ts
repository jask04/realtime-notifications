import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/ratelimit.js';
import {
  createNotification,
  IdempotencyInFlightError,
} from '../services/notifications.service.js';
import { fanoutNotification } from '../services/fanout.service.js';

const createBody = z.object({
  userId: z.string().min(1),
  type: z.string().min(1).max(100),
  channel: z.enum(['websocket', 'email']),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

const historyQuery = z.object({
  status: z
    .enum(['PENDING', 'QUEUED', 'SENT', 'FAILED', 'DEAD_LETTER'])
    .optional(),
  channel: z.enum(['websocket', 'email']).optional(),
  // 50 by default, hard-capped at 200 so a malicious caller can't ask for
  // a million rows in one request and pin the DB.
  limit: z.coerce.number().int().positive().max(200).default(50),
  // Opaque-to-the-client id of the last notification on the previous page.
  // We don't paginate by `(createdAt, id)` because cuids are time-ordered
  // already — id alone gives a stable sort that matches `ORDER BY createdAt
  // DESC` for any one user's history.
  cursor: z.string().min(1).optional(),
});

const fanoutBody = z.object({
  // Cap intentionally low — really large fanouts should batch through a
  // background scheduler, not synchronous HTTP. 1000 is enough to cover
  // the "notify everyone in a small org" case.
  userIds: z.array(z.string().min(1)).min(1).max(1000),
  type: z.string().min(1).max(100),
  channel: z.enum(['websocket', 'email']),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

// 10 notifications per minute per recipient. Burst is the same as
// capacity — the bucket starts full so a freshly-onboarded user can still
// get their welcome+confirmation+receipt rapid-fire on day one.
const PER_RECIPIENT_RATE_LIMIT = {
  capacity: 10,
  windowSeconds: 60,
  bucketKey: (request: FastifyRequest): string | null => {
    const userId = (request.body as { userId?: unknown } | undefined)?.userId;
    return typeof userId === 'string' && userId.length > 0
      ? `ratelimit:notify:${userId}`
      : null;
  },
};

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  // Authenticated history of the caller's own notifications. Filterable by
  // status and channel; paginates forward via opaque cursor.
  app.get(
    '/notifications',
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = historyQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid query',
          issues: parsed.error.flatten(),
        });
      }
      const { status, channel, limit, cursor } = parsed.data;

      const rows = await prisma.notification.findMany({
        where: {
          userId: request.user.id,
          ...(status ? { status } : {}),
          ...(channel ? { channel } : {}),
        },
        orderBy: { createdAt: 'desc' },
        // Take one extra so we can tell the client whether there's another
        // page without making them ask twice.
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

      return reply.send({ items, nextCursor });
    },
  );

  app.post(
    '/notifications',
    {
      // Order matters: authenticate first so unauthenticated traffic
      // doesn't consume rate-limit budget.
      preHandler: [authenticate, rateLimitMiddleware(PER_RECIPIENT_RATE_LIMIT)],
    },
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid body',
          issues: parsed.error.flatten(),
        });
      }

      try {
        const { notification, created } = await createNotification(parsed.data);
        return reply.code(created ? 201 : 200).send({ notification });
      } catch (err) {
        if (err instanceof IdempotencyInFlightError) {
          return reply.code(409).send({
            error: 'Duplicate request still in flight, retry shortly',
          });
        }
        // Foreign key violation on userId — the recipient doesn't exist.
        // Nicer than a 500 with a Prisma stack trace.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2003'
        ) {
          return reply
            .code(404)
            .send({ error: 'Recipient user does not exist' });
        }
        throw err;
      }
    },
  );

  // Fan-out is intentionally NOT rate-limited per recipient — the
  // limiter is keyed by recipient and a fan-out targets many. Per-caller
  // limits would belong here if abuse becomes a concern; for now the 1000-
  // user cap on the body is the only guardrail.
  app.post(
    '/notifications/fanout',
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = fanoutBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid body',
          issues: parsed.error.flatten(),
        });
      }

      const result = await fanoutNotification(parsed.data);
      return reply.code(200).send(result);
    },
  );
};
