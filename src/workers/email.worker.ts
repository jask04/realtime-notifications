import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { wrap } from '../lib/email-template.js';
import { getMailer } from '../lib/mailer.js';
import { redis } from '../queue/connection.js';
import {
  EMAIL_QUEUE,
  type NotificationJobData,
} from '../queue/notifications.js';
import { attachFailureHandler } from './failure-handler.js';

// Shape the API caller has to put in `payload` for an email channel.
// Validated per-job rather than at the API boundary because the API doesn't
// (yet) know which payload schema applies to which channel — Day 9 may
// pull this up to the route validator.
const emailPayloadSchema = z.object({
  subject: z.string().min(1).max(200),
  html: z.string().min(1),
  text: z.string().optional(),
});
type EmailPayload = z.infer<typeof emailPayloadSchema>;

export function createEmailWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(EMAIL_QUEUE, handleJob, {
    connection: redis,
    // Email is slower (network round-trips to the SMTP server). Lower
    // concurrency than the websocket worker so we don't fan out and get
    // rate-limited by the upstream provider.
    concurrency: 5,
  });

  attachFailureHandler(worker);
  return worker;
}

async function handleJob(job: Job<NotificationJobData>): Promise<void> {
  const { notificationId, userId, payload } = job.data;

  // Validate the channel-specific payload here; a malformed payload won't
  // get better with retries, so opt out of the retry budget.
  const parsed = emailPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UnrecoverableError(
      `invalid email payload: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
    );
  }
  const emailPayload: EmailPayload = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) {
    throw new UnrecoverableError(`recipient user ${userId} no longer exists`);
  }

  const html = wrap(emailPayload.subject, emailPayload.html);

  await getMailer().sendMail({
    from: config.SMTP_FROM,
    to: user.email,
    subject: emailPayload.subject,
    html,
    text: emailPayload.text,
  });

  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'SENT', deliveredAt: new Date() },
  });
}
