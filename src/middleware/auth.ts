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
