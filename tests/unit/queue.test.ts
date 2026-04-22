import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  enqueueNotification,
  notificationQueue,
  type NotificationJobData,
} from '../../src/queue/notifications.js';
import { deadLetterQueue, moveToDLQ } from '../../src/queue/deadletter.js';
import { redis } from '../../src/queue/connection.js';

beforeAll(async () => {
  // Start each test run from an empty queue so assertions on 'waiting' are deterministic.
  await notificationQueue.obliterate({ force: true });
  await deadLetterQueue.obliterate({ force: true });
});

afterAll(async () => {
  await notificationQueue.close();
  await deadLetterQueue.close();
  await redis.quit();
});

test('enqueueNotification puts a job in the waiting state', async () => {
  const data: NotificationJobData = {
    notificationId: 'n_test_1',
    userId: 'u_test_1',
    channel: 'websocket',
    payload: { title: 'hello' },
  };

  const jobId = await enqueueNotification(data);
  expect(jobId).toBeTypeOf('string');

  const waiting = await notificationQueue.getJobs(['waiting']);
  const found = waiting.find((j) => j.id === jobId);
  expect(found).toBeDefined();
  expect(found?.data).toEqual(data);
  expect(found?.opts.attempts).toBe(5);
});

test('moveToDLQ copies a job into the dead-letter queue with metadata', async () => {
  const data: NotificationJobData = {
    notificationId: 'n_test_2',
    userId: 'u_test_2',
    channel: 'email',
    payload: { subject: 'boom' },
  };
  const jobId = await enqueueNotification(data);
  const job = await notificationQueue.getJob(jobId);
  if (!job) throw new Error('enqueued job not found');

  await moveToDLQ(job, 'simulated permanent failure');

  const dlqJobs = await deadLetterQueue.getJobs(['waiting']);
  const dead = dlqJobs.find((j) => j.data.originalJobId === jobId);
  expect(dead).toBeDefined();
  expect(dead?.data.reason).toBe('simulated permanent failure');
  expect(dead?.data.channel).toBe('email');
  expect(dead?.data.failedAt).toBeTypeOf('string');
});
