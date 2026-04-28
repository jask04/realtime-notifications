import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../queue/connection.js';

/**
 * Token-bucket rate limiter, atomic in Redis.
 *
 * Why a Lua script: a naive "GET tokens, decrement, SET tokens" sequence
 * has an obvious race when two requests land in the same millisecond. The
 * script runs server-side so the read-update-write sequence holds Redis's
 * single-threaded event loop for the duration — concurrent calls observe
 * each other's writes.
 *
 * The bucket is stored as a hash with two fields:
 *   - tokens: current token count (float, written as a string)
 *   - last_refill: epoch ms of the last refill calculation
 *
 * Refill is continuous: tokens accumulate at `capacity / windowMs` per ms
 * since `last_refill`, capped at `capacity`. So a fresh bucket starts at
 * full capacity, a fully-drained bucket recovers to full over `windowMs`.
 *
 * Returns: [allowed (0|1), remaining_tokens (int floor), retry_after_ms].
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per millisecond
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill = now
else
  local elapsed = math.max(0, now - last_refill)
  tokens = math.min(capacity, tokens + elapsed * refill_rate)
  last_refill = now
end

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local missing = cost - tokens
  retry_after_ms = math.ceil(missing / refill_rate)
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
-- Idle buckets shouldn't sit in Redis forever. 2x window is plenty —
-- after that the bucket would refill to full anyway.
redis.call('PEXPIRE', key, math.max(120000, math.floor(2 * capacity / refill_rate)))

return { allowed, math.floor(tokens), retry_after_ms }
`;

let cachedSha: string | null = null;

async function runScript(
  key: string,
  capacity: number,
  refillRatePerMs: number,
  nowMs: number,
  cost: number,
): Promise<[number, number, number]> {
  const args = [
    String(capacity),
    String(refillRatePerMs),
    String(nowMs),
    String(cost),
  ];

  if (!cachedSha) {
    cachedSha = (await redis.script('LOAD', TOKEN_BUCKET_LUA)) as string;
  }

  try {
    const result = (await redis.evalsha(cachedSha, 1, key, ...args)) as [
      number,
      number,
      number,
    ];
    return result;
  } catch (err) {
    // If Redis flushed the script cache (FLUSHALL, restart, etc.), reload
    // and try once more.
    if (
      err instanceof Error &&
      err.message.includes('NOSCRIPT')
    ) {
      cachedSha = (await redis.script('LOAD', TOKEN_BUCKET_LUA)) as string;
      const result = (await redis.evalsha(cachedSha, 1, key, ...args)) as [
        number,
        number,
        number,
      ];
      return result;
    }
    throw err;
  }
}

export interface RateLimitOptions {
  /** Token bucket capacity — also the burst size. */
  capacity: number;
  /** Window over which the bucket fully refills, in seconds. */
  windowSeconds: number;
  /** How to compute the bucket key from a request. */
  bucketKey: (request: FastifyRequest) => string | null;
  /** Tokens consumed per request. Defaults to 1. */
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  options: RateLimitOptions,
  key: string,
): Promise<RateLimitResult> {
  const refillRatePerMs = options.capacity / (options.windowSeconds * 1000);
  const [allowed, remaining, retryAfterMs] = await runScript(
    key,
    options.capacity,
    refillRatePerMs,
    Date.now(),
    options.cost ?? 1,
  );
  return {
    allowed: allowed === 1,
    remaining,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  };
}

/**
 * Build a Fastify preHandler that enforces a rate limit and replies 429
 * with a `Retry-After` header when the bucket is empty.
 *
 * If `bucketKey` returns `null`, the limiter no-ops — useful when the
 * keying field (e.g. `body.userId`) is missing and the route's body
 * validator will reject the request anyway.
 */
export function rateLimitMiddleware(options: RateLimitOptions) {
  return async function rateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = options.bucketKey(request);
    if (!key) return;

    const result = await checkRateLimit(options, key);
    if (!result.allowed) {
      reply.header('Retry-After', String(result.retryAfterSeconds));
      reply.header('X-RateLimit-Remaining', String(result.remaining));
      await reply.code(429).send({
        error: 'Too many requests for this recipient',
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }
    reply.header('X-RateLimit-Remaining', String(result.remaining));
  };
}
