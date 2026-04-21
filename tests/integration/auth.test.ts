import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/client.js';

type App = Awaited<ReturnType<typeof createApp>>;

describe('auth flow', () => {
  let app: App;
  const email = `auth+${Date.now()}@test.local`;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  test('POST /auth/dev-token returns a valid JWT and upserts the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: { id: string; email: string } };
    expect(body.token).toBeTypeOf('string');
    expect(body.user.email).toBe(email);

    // Decoding via the app's jwt plugin should produce the same identity.
    const decoded = app.jwt.verify<{ id: string; email: string }>(body.token);
    expect(decoded.id).toBe(body.user.id);
    expect(decoded.email).toBe(email);
  });

  test('GET /me returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  test('GET /me returns the caller when a valid token is sent', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email },
    });
    const { token, user } = tokenRes.json() as {
      token: string;
      user: { id: string; email: string };
    };

    const meRes = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json() as { user: { id: string; email: string } };
    expect(meBody.user.id).toBe(user.id);
    expect(meBody.user.email).toBe(email);
  });

  test('POST /auth/dev-token rejects malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});
