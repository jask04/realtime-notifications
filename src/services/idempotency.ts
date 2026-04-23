import { redis } from '../queue/connection.js';

// Prefix keeps idempotency reservations visually separate from queue / cache
// keys in Redis — easier to eyeball with `KEYS idem:*` when debugging.
const KEY_PREFIX = 'idem:notification:';

// 24h is the conventional window for "don't double-send this": long enough
// to cover client retries across network blips, short enough that operators
// aren't debugging week-old dedupe state.
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24;

function redisKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/**
 * Atomically claim an idempotency key for the caller.
 *
 * Returns `true` the first time a given key is seen (the caller "owns" the
 * request and should proceed with the real work), and `false` on every
 * subsequent call within the TTL (the caller should return the already-created
 * resource instead of doing the work a second time).
 *
 * Uses `SET key value NX EX ttl` so the check-and-set is a single round-trip
 * and safe against concurrent callers racing the same key.
 */
export async function checkAndReserve(
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis.set(redisKey(key), '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Drop a reservation. Called when the downstream work fails and we want the
 * next retry (from the same client, same key) to be allowed to try again
 * rather than hit a false "duplicate" response.
 */
export async function releaseReservation(key: string): Promise<void> {
  await redis.del(redisKey(key));
}
