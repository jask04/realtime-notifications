import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/ratelimit.js';

const devTokenBody = z.object({
  email: z.string().email(),
  // Optional role claim — only `admin` is recognised, anything else is
  // ignored. Lets the dev-token endpoint mint admin credentials for the
  // /admin routes without needing a separate signup flow.
  role: z.enum(['admin']).optional(),
});

// Public demo endpoint: lets visitors to the live deploy mint a short-lived
// token, connect a WebSocket, and POST a notification at themselves — the
// landing page at `/` drives this end-to-end.
//
// 5 tokens per hour per IP. Generous enough for a recruiter to retry if
// they fumble the demo, low enough that nothing useful happens if a bot
// hammers the endpoint. Bucket key includes "demo-token" so this limit
// is independent of the per-recipient limiter on POST /notifications.
const DEMO_TOKEN_RATE_LIMIT = {
  capacity: 5,
  windowSeconds: 60 * 60,
  bucketKey: (request: FastifyRequest): string =>
    `ratelimit:demo-token:${request.ip}`,
};

// 1h is long enough for a recruiter to tab away and come back, short
// enough that a leaked token is mostly harmless.
const DEMO_TOKEN_TTL = '1h';

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

    const { email, role } = parsed.data;
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });

    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      ...(role ? { role } : {}),
    });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        ...(role ? { role } : {}),
      },
    };
  });

  // Public demo token. Per-IP rate-limited so a bot can't pile up rows;
  // creates a throwaway `demo+...@demo.local` user; signs a 1h JWT with
  // `role: 'demo'` so the rest of the system can recognise demo callers
  // and gate sensitive endpoints (see /notifications/fanout).
  app.post(
    '/auth/demo-token',
    { preHandler: rateLimitMiddleware(DEMO_TOKEN_RATE_LIMIT) },
    async (_request, reply) => {
      // 16 hex chars = 64 bits of entropy, enough that two demo visitors
      // colliding is effectively impossible without trying.
      const suffix = crypto.randomBytes(8).toString('hex');
      const email = `demo+${suffix}@demo.local`;
      const user = await prisma.user.create({ data: { email } });

      const token = app.jwt.sign(
        { id: user.id, email: user.email, role: 'demo' },
        { expiresIn: DEMO_TOKEN_TTL },
      );
      return reply.send({
        token,
        user: { id: user.id, email: user.email, role: 'demo' },
        expiresIn: DEMO_TOKEN_TTL,
      });
    },
  );

  // Protected — returns the caller's identity. Useful as a sanity check
  // and for the integration test.
  app.get('/me', { preHandler: authenticate }, async (request) => {
    return { user: request.user };
  });
};
