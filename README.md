# realtime-notifications

[![CI](https://github.com/jask04/realtime-notifications/actions/workflows/ci.yml/badge.svg)](https://github.com/jask04/realtime-notifications/actions/workflows/ci.yml)

Real-time notification service. WebSocket delivery for online users, an email
fallback for everyone else, and a Postgres history of every send. Built with
production patterns I'd want to ship at work — idempotency, dead-letter
queue, per-recipient rate limiting, graceful shutdown, structured logging.

**Live:** [`realtime-notifications-production.up.railway.app/health`](https://realtime-notifications-production.up.railway.app/health) (Railway, with managed Postgres + Redis plugins)

## What it does

- `POST /notifications` — accept a notification, write a row in Postgres,
  enqueue a delivery job. Idempotent on a client-supplied key.
- `POST /notifications/fanout` — same thing, but for up to 1000 recipients
  in one request. One job per recipient so retries are scoped per user.
- WebSocket clients connect with a JWT and receive their notifications live.
- Email worker delivers the rest via SMTP (Mailtrap in dev, swap for
  SES/SendGrid in prod).
- `GET /notifications` — paginated history of the caller's own notifications,
  filterable by status and channel.
- `GET /admin/queue/*` — operator endpoints for queue stats, DLQ inspection,
  and re-driving dead-lettered jobs.

## Architecture

```
                            ┌──────────────────┐
                            │  Postgres        │
                            │  (notifications, │
                            │   users, idem)   │
                            └────────▲─────────┘
                                     │
  POST /notifications        ┌───────┴────────┐
  ────────────────────────▶  │  Fastify API   │  ◀─── JWT (Bearer)
  GET  /notifications        │  + Socket.io   │  ◀─── WebSocket clients
                             └───┬────────┬───┘
                                 │        │
                       enqueue   │        │   subscribe (Redis adapter)
                                 ▼        ▼
                          ┌───────────────────┐
                          │  Redis            │
                          │  (BullMQ queues + │
                          │   pub/sub fanout) │
                          └───┬─────────┬─────┘
                              │         │
                   websocket  │         │  email
                   queue      │         │  queue
                              ▼         ▼
                       ┌──────────┐ ┌─────────────┐
                       │  WS      │ │  Email      │
                       │  worker  │ │  worker     │
                       └──────────┘ └─────────────┘
                              │            │
                       emit to socket   SMTP send
```

### Design notes

- **One queue per channel.** BullMQ workers don't filter by job name —
  every worker on a queue competes for every job. With a single queue and
  two workers (websocket, email) they'd race for each other's jobs and
  silently drop work. Separate queues let each channel tune retries,
  concurrency, and rate limits independently.
- **DB writes happen after the emit.** If the WebSocket emit throws, the
  notification stays in `QUEUED` so a retry can try again — never a `SENT`
  row that wasn't actually sent.
- **Idempotency is two-layered.** Redis `SET NX EX` is the fast path
  (constant-time dedupe). Postgres' unique index on `idempotencyKey` is
  the source of truth — if Redis flushes mid-flight, the DB still rejects
  the duplicate.
- **Offline recipients retry, then dead-letter.** If a user has no live
  WebSocket connections, the worker throws a sentinel error. BullMQ retries
  under exponential backoff (5 attempts). After exhaustion, the failure
  handler moves the job to a dead-letter queue and flips the row to
  `DEAD_LETTER` with the reason. The admin DLQ-retry endpoint re-enqueues it.
- **Per-recipient rate limiting** is a Lua script in Redis (token bucket,
  10 req/min/user). Lua because read-then-write outside a script races
  under load.
- **The Socket.io Redis adapter** lets the WebSocket worker push to a user
  whose socket is connected to a different API instance — the prerequisite
  for horizontal scaling.
- **Graceful shutdown closes resources in dependency order**: HTTP first
  (no new requests), then workers (drain in-flight jobs), then queues, then
  Prisma, then Redis (last, because everyone above held connections to it).

## Stack

| Layer       | Choice                                        |
| ----------- | --------------------------------------------- |
| Runtime     | Node 22+, TypeScript (ESM, strict)            |
| HTTP        | Fastify 5 + @fastify/jwt + @fastify/helmet    |
| WebSocket   | Socket.io 4 + @socket.io/redis-adapter        |
| Queue       | BullMQ 5 (Redis 7)                            |
| DB          | Postgres 16 via Prisma 6                      |
| Validation  | Zod 4                                         |
| Logging     | Pino                                          |
| Tests       | Vitest 4 (unit + integration, real services)  |
| CI          | GitHub Actions (Postgres + Redis services)    |
| Deploy      | Railway (Postgres + Redis plugins)            |

## Running locally

Requires Docker (for Postgres + Redis) and Node 22+.

```bash
git clone https://github.com/jask04/realtime-notifications.git
cd realtime-notifications
cp .env.example .env          # edit Mailtrap creds for the email worker
docker compose up -d          # postgres + redis
npm install                   # postinstall runs `prisma generate`
npx prisma migrate dev        # apply schema
npm run dev                   # http://localhost:3000
```

`GET /health` should return `{"ok": true, "uptime": ...}`. Open
`http://localhost:3000/ws-test.html?token=<jwt>` for a browser WebSocket
client; mint a token via `POST /auth/dev-token { "email": "..." }`.

The full test suite (`npm test`) runs against the same Postgres + Redis
your dev server uses — they're integration tests, not heavy mocking.

## API reference

All endpoints except `/health` and `/auth/dev-token` require a Bearer JWT.
`/admin/*` additionally requires `role: "admin"` in the JWT.

### Auth (dev only — returns 404 in production)

| Method | Path                | Body                                | Returns                          |
| ------ | ------------------- | ----------------------------------- | -------------------------------- |
| POST   | `/auth/dev-token`   | `{ email, role? }`                  | `{ token, user }`                |
| GET    | `/me`               | —                                   | `{ user }`                       |

### Notifications

| Method | Path                       | Body / Query                                                  | Returns / Notes                                                            |
| ------ | -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/notifications`           | `{ userId, type, channel, payload, idempotencyKey? }`         | 201 created / 200 idempotent replay. Rate limited 10/min per recipient.    |
| POST   | `/notifications/fanout`    | `{ userIds[], type, channel, payload, idempotencyKey? }`      | `{ enqueued, skipped }`. Up to 1000 recipients.                            |
| GET    | `/notifications`           | `?status=&channel=&limit=50&cursor=`                          | `{ items, nextCursor }`. Paginated, caller-only.                           |

### WebSocket

Connect to the same origin with a JWT in `auth.token` (preferred) or
`?token=` query. Server emits `connected` on handshake and `notification`
when a delivery lands.

### Admin (requires `role: "admin"` JWT)

| Method | Path                                  | Returns                                                |
| ------ | ------------------------------------- | ------------------------------------------------------ |
| GET    | `/admin/queue/stats`                  | Per-queue counts (waiting/active/completed/failed)     |
| GET    | `/admin/queue/dlq?limit=50`           | Dead-letter jobs with failure reason                   |
| POST   | `/admin/queue/dlq/:jobId/retry`       | Re-enqueue a DLQ job, reset the row to `QUEUED`        |

Every response carries an `X-Request-Id` header. `5xx` bodies include the
same id so a user reporting a problem can quote it back and the matching
log line is one grep away.

## Deploying

### Railway (one-click)

1. Create a new project from this GitHub repo.
2. Add the **Postgres** plugin → it sets `DATABASE_URL`.
3. Add the **Redis** plugin → it sets `REDIS_URL`.
4. Set the rest of the environment variables in the dashboard:

   ```
   JWT_SECRET=<32+ char random string>
   NODE_ENV=production
   SMTP_HOST=sandbox.smtp.mailtrap.io
   SMTP_PORT=2525
   SMTP_USER=<from mailtrap>
   SMTP_PASS=<from mailtrap>
   SMTP_FROM=notifications@your-domain.example
   ```

5. `railway.toml` does the rest: `npm run build` → `npm start` (which runs
   `prisma migrate deploy` before booting), with `/health` as the
   healthcheck path so a broken deploy rolls back automatically.

### Anywhere else

Standard Node service. Build with `npm run build`, run with `npm start`.
Provide `DATABASE_URL`, `REDIS_URL`, and the SMTP/JWT vars from
`.env.example`. The `start` script runs migrations on boot — for larger
teams that's a separate release step, but for a small service the
boot-time migration is the simpler contract.

## What's deliberately not here

A few things you'd want before shipping this to a real product:

- **Auth beyond the dev-token.** A real signup/login + refresh-token flow
  belongs at the edge (Auth0 / Clerk / your own service). The JWT
  middleware is ready for whatever issues those tokens.
- **Notification preferences.** A `users.notification_settings` table and
  a check before enqueue would let users opt out of channels.
- **Quiet hours / batching / digests.** All scheduling primitives — BullMQ
  delayed jobs cover the mechanics; the policy is product work.
- **Push (APNs/FCM).** A third channel; same shape as the email worker.
- **Observability.** Pino logs land on stdout; production would feed them
  into Datadog/Honeycomb and instrument with OpenTelemetry traces.

## Repo layout

```
src/
  app.ts              Fastify app factory (createApp)
  server.ts           Production entrypoint (api + workers)
  config.ts           Zod-validated env config
  db/                 Prisma client singleton
  routes/             auth, notifications, admin
  middleware/         authenticate, requireAdmin, rateLimit
  services/           idempotency, notifications, fanout
  queue/              BullMQ queues + DLQ + Redis connection
  workers/            websocket worker, email worker, shared failure handler
  ws/                 Socket.io plugin, in-memory connection registry
  lib/                logger, mailer, error handler, shutdown helper
prisma/
  schema.prisma       User + Notification + status enum
  migrations/
tests/
  unit/               db, queue, shutdown
  integration/        end-to-end with real Postgres + Redis
.github/workflows/
  ci.yml              Lint + typecheck + tests on every push
public/
  ws-test.html        Browser WebSocket debug page
```
