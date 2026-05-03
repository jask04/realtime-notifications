import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Fastify preHandler that verifies a Bearer JWT and populates `request.user`.
 * Replies 401 on a missing/invalid token.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: 'Unauthorized' });
  }
}

/**
 * Fastify preHandler that runs `authenticate` and then requires the JWT to
 * carry `role: 'admin'`. Replies 401 on a missing/invalid token (same as
 * `authenticate`) and 403 on an authenticated non-admin caller — the
 * distinction matters because 401 means "log in" while 403 means "your
 * account can't do this."
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  if (request.user.role !== 'admin') {
    await reply.code(403).send({ error: 'Admin role required' });
  }
}

/**
 * Fastify preHandler that rejects callers minted by `/auth/demo-token`.
 * Used on high-blast-radius endpoints (e.g. fanout) so an anonymous demo
 * visitor can't trigger a thousand-recipient send. Assumes `authenticate`
 * (or another preHandler that calls `jwtVerify`) has already run — wire
 * it after that one in the route's `preHandler` array.
 */
export async function blockDemoRole(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.user?.role === 'demo') {
    await reply.code(403).send({
      error: 'Demo accounts cannot use this endpoint',
    });
  }
}
