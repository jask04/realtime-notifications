import { Prisma } from '@prisma/client';
import type { NotificationChannel } from '../queue/notifications.js';
import {
  createNotification,
  IdempotencyInFlightError,
} from './notifications.service.js';

export interface FanoutInput {
  userIds: string[];
  type: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  /**
   * Optional base idempotency key. The service derives a per-recipient key
   * by suffixing `:userId` so each recipient's dedup state is independent —
   * a retried fanout call won't double-send to anyone, and a single
   * recipient appearing in two different fanouts is still treated as two
   * separate notifications (different base keys → different per-user keys).
   */
  idempotencyKey?: string;
}

export interface FanoutResult {
  enqueued: number;
  skipped: { userId: string; reason: string }[];
}

/**
 * Create one notification + one queue job per recipient.
 *
 * One job per recipient (rather than a single job with N targets) keeps
 * retries scoped to the recipient that actually failed. If 1 of 100
 * recipients hits a transient SMTP error, only that one job retries; the
 * other 99 are already SENT and unaffected.
 *
 * Iteration is sequential. Could be parallelised with a bounded
 * concurrency, but at 1000 max recipients per call the wall-clock win is
 * modest and the predictability is worth more — a fanout that returns
 * `{enqueued: 750, skipped: [...250]}` is much easier to reason about
 * when the order of operations is deterministic.
 */
export async function fanoutNotification(
  input: FanoutInput,
): Promise<FanoutResult> {
  // Dedupe — a caller passing the same userId twice in one request was
  // almost certainly a mistake; treat it as one recipient. With an
  // idempotency key the per-user keys would dedupe anyway, but without
  // one we'd otherwise create two rows for the same user.
  const userIds = Array.from(new Set(input.userIds));

  const skipped: FanoutResult['skipped'] = [];
  let enqueued = 0;

  for (const userId of userIds) {
    const perUserKey = input.idempotencyKey
      ? `${input.idempotencyKey}:${userId}`
      : undefined;

    try {
      const result = await createNotification({
        userId,
        type: input.type,
        channel: input.channel,
        payload: input.payload,
        idempotencyKey: perUserKey,
      });
      if (result.created) {
        enqueued += 1;
      } else {
        skipped.push({
          userId,
          reason: 'already enqueued (idempotent replay)',
        });
      }
    } catch (err) {
      if (err instanceof IdempotencyInFlightError) {
        skipped.push({ userId, reason: 'duplicate request still in flight' });
        continue;
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        skipped.push({ userId, reason: 'recipient user does not exist' });
        continue;
      }
      // Unknown error — re-throw so the route returns 500 rather than
      // silently hiding a real problem behind `skipped`.
      throw err;
    }
  }

  return { enqueued, skipped };
}
