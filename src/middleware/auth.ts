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
