import type { Notification } from '@prisma/client';
import { prisma } from '../db/client.js';
import {
  enqueueNotification,
  type NotificationChannel,
} from '../queue/notifications.js';
import { checkAndReserve, releaseReservation } from './idempotency.js';

export interface CreateNotificationInput {
  userId: string;
  type: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CreateNotificationResult {
  notification: Notification;
  // Whether this call created a new notification (true) or returned a previously
  // stored one matched by idempotency key (false). Lets the route return 201 vs 200.
  created: boolean;
}

/**
 * Thrown when a caller retries with an idempotency key that's currently
 * reserved in Redis but the original request hasn't committed its row to
 * Postgres yet. Surfaces as HTTP 409 — the caller should back off and retry.
 *
 * This happens in the narrow window between `checkAndReserve` succeeding
 * and the DB transaction committing on the original request.
 */
export class IdempotencyInFlightError extends Error {
  constructor(key: string) {
    super(`idempotency key "${key}" is reserved but not yet committed`);
    this.name = 'IdempotencyInFlightError';
  }
}

/**
 * Create a notification: row in Postgres, job on the BullMQ queue, status
 * flipped to QUEUED on success. The insert, the enqueue, and the status
 * update all happen inside a single Prisma transaction so a failed enqueue
 * rolls back the row — we never leave an orphaned PENDING notification that
 * has no job behind it.
 *
 * Idempotency handling: if `idempotencyKey` is provided we try to claim it
 * in Redis first. Losing the race means this is a duplicate request; we
 * return the previously-stored notification instead of creating a new one.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  const { userId, type, channel, payload, idempotencyKey } = input;

  if (idempotencyKey) {
    const reserved = await checkAndReserve(idempotencyKey);
    if (!reserved) {
      const existing = await prisma.notification.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { notification: existing, created: false };
      }
      // Key reserved in Redis but no row yet — the first request is
      // mid-flight (or died after reserving and before inserting). Signal
      // the caller to retry rather than silently creating a second row.
      throw new IdempotencyInFlightError(idempotencyKey);
    }
  }

  try {
    const notification = await prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          userId,
          type,
          channel,
          payload: payload as object, // Prisma's Json input type
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      // Enqueue inside the transaction so a failed enqueue throws and rolls
      // back the insert. The reverse failure mode — enqueue succeeds, commit
      // fails — leaves a job referencing a missing notificationId; the
      // worker treats that as a permanent failure and DLQs the job.
      await enqueueNotification({
        notificationId: created.id,
        userId,
        channel,
        payload,
      });

      return tx.notification.update({
        where: { id: created.id },
        data: { status: 'QUEUED' },
      });
    });

    return { notification, created: true };
  } catch (err) {
    // On any failure, drop the Redis reservation so a genuine retry from
    // the client isn't blocked by a ghost key.
    if (idempotencyKey) {
      await releaseReservation(idempotencyKey).catch(() => {
        // Best-effort cleanup; the TTL will expire it within 24h regardless.
      });
    }
    throw err;
  }
}
