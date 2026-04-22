import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config.js';

// BullMQ requires `maxRetriesPerRequest: null` on the shared connection:
// otherwise blocking commands (BRPOPLPUSH, XREAD, etc.) get retried and
// BullMQ's workers time out. See BullMQ docs — "Connections".
const options: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

export function createRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, options);
}

// Shared connection used by queues and workers in the same process.
// Consumers that want their own lifecycle (tests, one-off scripts) can call
// createRedisConnection() directly.
export const redis = createRedisConnection();
