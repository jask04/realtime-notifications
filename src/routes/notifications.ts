import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import {
  createNotification,
  IdempotencyInFlightError,
} from '../services/notifications.service.js';

const createBody = z.object({
  userId: z.string().min(1),
  type: z.string().min(1).max(100),
  channel: z.enum(['websocket', 'email']),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/notifications',
    { preHandler: authenticate },
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
};
