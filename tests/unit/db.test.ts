import { afterAll, expect, test } from 'vitest';
import { prisma } from '../../src/db/client.js';

afterAll(async () => {
  await prisma.$disconnect();
});

test('can connect, create a user, and delete them', async () => {
  const email = `smoke+${Date.now()}@test.local`;

  const created = await prisma.user.create({ data: { email } });
  expect(created.id).toBeTypeOf('string');
  expect(created.email).toBe(email);

  const found = await prisma.user.findUnique({ where: { email } });
  expect(found?.id).toBe(created.id);

  await prisma.user.delete({ where: { id: created.id } });

  const afterDelete = await prisma.user.findUnique({ where: { email } });
  expect(afterDelete).toBeNull();
});
