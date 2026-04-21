import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/auth.js';

const devTokenBody = z.object({
  email: z.string().email(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Dev-only: exchange an email for a signed JWT. Creates the user on first hit.
  // Intentionally returns 404 in production so the endpoint is invisible there.
  app.post('/auth/dev-token', async (request, reply) => {
    if (config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not Found' });
    }

    const parsed = devTokenBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid body',
        issues: parsed.error.flatten(),
      });
    }

    const { email } = parsed.data;
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });

    const token = app.jwt.sign({ id: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  });

  // Protected — returns the caller's identity. Useful as a sanity check
  // and for the integration test.
  app.get('/me', { preHandler: authenticate }, async (request) => {
    return { user: request.user };
  });
};
