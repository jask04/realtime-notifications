import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

/**
 * Centralised Fastify error handler.
 *
 * Goals:
 * - Consistent JSON shape for clients: `{ error, requestId, ... }`.
 * - Validation errors keep their issue list so the caller can fix the request.
 * - 4xx errors thrown elsewhere in the stack pass through with their message.
 * - 5xx errors are logged with full context but never leak the message or
 *   stack to the client — those can contain DB column names, file paths,
 *   and other internals you don't want a public API surfacing.
 *
 * Every response also carries the requestId so a user reporting "request
 * X failed" can quote it back and we can pull the matching log line.
 */
export function appErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // Fastify wraps schema/validator failures in `{ validation: [...] }`.
  if (error.validation) {
    request.log.info(
      { err: error, requestId, validation: error.validation },
      'validation error',
    );
    void reply.code(400).send({
      error: 'Bad request',
      requestId,
      issues: error.validation,
    });
    return;
  }

  // A handler that already chose its status code (e.g. `reply.code(401)`)
  // and threw a typed error gets passed through. Anything < 500 is a client
  // error — the message is meant for them.
  if (
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    request.log.info({ err: error, requestId }, 'client error');
    void reply.code(error.statusCode).send({
      error: error.message || 'Request failed',
      requestId,
    });
    return;
  }

  // Anything else is a 5xx. Log everything, return nothing useful — the
  // requestId is the bridge between "user sees an opaque 500" and "operator
  // grepping logs."
  request.log.error(
    { err: error, requestId, url: request.url, method: request.method },
    'unhandled request error',
  );
  void reply.code(500).send({
    error: 'Internal server error',
    requestId,
  });
}
