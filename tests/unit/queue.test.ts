import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  enqueueNotification,
  notificationQueues,
  queueForChannel,
  type NotificationJobData,
} from '../../src/queue/notifications.js';
import { deadLetterQueue, moveToDLQ } from '../../src/queue/deadletter.js';
import { redis } from '../../src/queue/connection.js';

beforeAll(async () => {
  // Start each test run from empty queues so assertions on 'waiting' are deterministic.
  await Promise.all(notificationQueues.map((q) => q.obliterate({ force: true })));
  await deadLetterQueue.obliterate({ force: true });
});

afterAll(async () => {
  await Promise.all(notificationQueues.map((q) => q.close()));
  await deadLetterQueue.close();
  await redis.quit();
});

test('enqueueNotification puts a websocket job in the websocket queue', async () => {
  const data: NotificationJobData = {
    notificationId: 'n_test_1',
    userId: 'u_test_1',
    channel: 'websocket',
    payload: { title: 'hello' },
  };

  const jobId = await enqueueNotification(data);
  expect(jobId).toBeTypeOf('string');

  const wsQueue = queueForChannel('websocket');
  const waiting = await wsQueue.getJobs(['waiting']);
  const found = waiting.find((j) => j.id === jobId);
  expect(found).toBeDefined();
  expect(found?.data).toEqual(data);
  expect(found?.opts.attempts).toBe(5);

  // The email queue must not have picked it up — channel routing is the
  // whole point of splitting per-channel queues.
  const emailQueue = queueForChannel('email');
  const emailWaiting = await emailQueue.getJobs(['waiting']);
  expect(emailWaiting.find((j) => j.id === jobId)).toBeUndefined();
});

test('moveToDLQ copies a job into the dead-letter queue with metadata', async () => {
  const data: NotificationJobData = {
    notificationId: 'n_test_2',
    userId: 'u_test_2',
    channel: 'email',
    payload: { subject: 'boom' },
  };
  const jobId = await enqueueNotification(data);
  const emailQueue = queueForChannel('email');
  const job = await emailQueue.getJob(jobId);
  if (!job) throw new Error('enqueued job not found');

  await moveToDLQ(job, 'simulated permanent failure');

  const dlqJobs = await deadLetterQueue.getJobs(['waiting']);
  const dead = dlqJobs.find((j) => j.data.originalJobId === jobId);
  expect(dead).toBeDefined();
  expect(dead?.data.reason).toBe('simulated permanent failure');
  expect(dead?.data.channel).toBe('email');
  expect(dead?.data.failedAt).toBeTypeOf('string');
});
