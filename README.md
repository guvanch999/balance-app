# balance-app

[![CI](https://github.com/guvanch999/balance-app/actions/workflows/ci.yml/badge.svg)](https://github.com/guvanch999/balance-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small Node.js service about **correctness under concurrency**. It shows two patterns that come up in almost every backend, and tests them:

1. **Atomic balance updates in Postgres.** Many withdrawals can hit the same account at once. None of them get lost and the balance never goes negative.
2. **A distributed cron with a correct Redis lock.** Several instances run the same schedule, and each tick executes on exactly one of them. A lock can only be released by its owner, and it is renewed while a long task runs.

Stack: Node.js 24, Express 5, PostgreSQL (`pg`), Redis (`ioredis`), `cron`. Tests use the built-in `node:test` runner and need no external services by default.

> **Background.** This started as a technical assignment (a balance endpoint plus a "distributed task scheduler"). I later reworked it into a showcase. The rework fixed real bugs in the original (listed [below](#what-changed-from-the-original-assignment)), replaced the ORM with plain SQL so the important statements are visible, and added tests that demonstrate each failure mode before showing the fix.

---

## Contents

- [1. Balance updates without lost updates](#1-balance-updates-without-lost-updates)
- [2. A distributed cron with a correct Redis lock](#2-a-distributed-cron-with-a-correct-redis-lock)
- [API](#api)
- [Configuration](#configuration)
- [Running it](#running-it)
- [Tests](#tests)
- [Project layout](#project-layout)
- [What changed from the original assignment](#what-changed-from-the-original-assignment)

---

## 1. Balance updates without lost updates

### The problem

The obvious way to write a withdrawal is read, check, write:

```js
const { balance } = await db.query('SELECT balance FROM users WHERE id = $1', [id]);
if (balance < amount) throw new InsufficientFunds();
await db.query('UPDATE users SET balance = $2 WHERE id = $1', [id, balance - amount]);
```

This works for one request at a time and breaks as soon as two requests overlap:

```mermaid
sequenceDiagram
    participant A as Request A (withdraw 60)
    participant DB as users.balance
    participant B as Request B (withdraw 60)
    A->>DB: SELECT balance
    DB-->>A: 100
    B->>DB: SELECT balance
    DB-->>B: 100
    A->>DB: UPDATE balance = 100 - 60
    Note over DB: 40
    B->>DB: UPDATE balance = 100 - 60
    Note over DB: 40 (A's debit is lost)
```

Both checks passed against the same stale snapshot. 120 was paid out, only 60 was debited. With a different amount the same interleaving can push the balance below zero. This is the classic **lost update**. It does not show up in a manual test, only under load.

### The fix: one statement that checks and writes

```sql
UPDATE users
   SET balance = balance - $2, updated_at = now()
 WHERE id = $1 AND balance >= $2
RETURNING id, balance, updated_at;
```

([`src/balance/balanceService.js`](src/balance/balanceService.js))

- `balance - $2` is computed from the row as it is at write time, not from a value the application read earlier.
- `UPDATE` takes a row lock. A concurrent `UPDATE` on the same row waits for it. In `READ COMMITTED`, when the waiting statement continues, Postgres **re-evaluates the `WHERE` clause against the newly committed row**. If the money is gone, the guard fails and zero rows are updated.
- Zero rows means "refused". The service then does one extra `SELECT` to choose between `404 NOT_FOUND` and `409 INSUFFICIENT_FUNDS`. That read only picks the error message. It never decides whether money moves.

```mermaid
sequenceDiagram
    participant A as Request A (withdraw 600)
    participant PG as Postgres (row id=1, balance 1000)
    participant B as Request B (withdraw 600)
    A->>PG: UPDATE ... WHERE id=1 AND balance >= 600
    Note over PG: A holds the row lock, balance 400 (uncommitted)
    B->>PG: UPDATE ... WHERE id=1 AND balance >= 600
    Note over B,PG: B waits for A's row lock
    A->>PG: COMMIT
    Note over PG: B re-checks the WHERE clause on the new row: 400 >= 600 is false
    PG-->>B: 0 rows updated
    B-->>B: 409 INSUFFICIENT_FUNDS
```

There is no `SELECT ... FOR UPDATE`, no explicit transaction and no application-level mutex. A single statement is already atomic, and that is enough here.

**Defence in depth.** The column also has `CHECK (balance >= 0)` ([migration](src/db/migrations/001_init.sql)). If some future code path gets the arithmetic wrong, Postgres rejects the write instead of storing a negative balance.

**Input validation.** Amounts are integers in minor units (cents), between 1 and 1,000,000,000. They must be JSON numbers: `"100"`, `1.5`, `0` and negatives are rejected with `400`. Parameters are always bound (`$1`, `$2`), never interpolated into SQL.

---

## 2. A distributed cron with a correct Redis lock

Every instance loads the same tasks from Postgres and schedules them with `cron`. When a tick fires, all instances wake up at about the same moment, so they need to agree on who runs it.

### Why GET-then-SET is not a lock

The original version did this:

```js
const current = await redis.get(`task_lock:${taskId}`);
if (current) return false;
await redis.set(`task_lock:${taskId}`, serverId); // no NX, no expiry
return true;
```

It has three separate problems:

1. **Not atomic.** Two instances can both `GET` (empty) before either `SET`s, and then both "acquire" the lock. This is the same check-then-act race as the balance example. `test/unit/redisLock.test.js` reproduces it deterministically.
2. **No expiry.** If the holder crashes, the key stays forever and the task never runs again on any instance.
3. **Release is a blind `DEL`.** An instance deletes the key whether or not it still owns it (see below).

### Acquire: `SET key token NX PX ttl`

```
SET lock:task:42 "app-1:3f6c…" NX PX 30000
```

One command, executed atomically by Redis. `NX` means only set if absent, and `PX` sets an expiry. The value is a **random token per acquisition** (prefixed with the server id for readability). The token is what proves ownership later.

### Release: compare-and-delete in Lua

Why not just `DEL`? Consider this timeline:

1. Instance A acquires the lock with a 30 s TTL.
2. A stalls (GC pause, slow network, overloaded host) for longer than 30 s. The key expires.
3. Instance B acquires the lock and starts the task.
4. A wakes up, finishes, and calls `DEL`. **That deletes B's lock**, and instance C is now free to start a third copy.

The release must delete the key only if it still holds *our* token. Doing `GET` and then `DEL` from the client has the same race as before, so it runs as a Lua script, which Redis executes without interleaving other commands:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
```

Renewal uses the same shape with `pexpire` instead of `del` ([`src/scheduler/redisLock.js`](src/scheduler/redisLock.js)).

### One tick, end to end

```mermaid
flowchart TD
    T([cron tick fires on every instance]) --> O{"SET sched:occurrence:task:second<br/>NX PX 60s"}
    O -- "not OK: another instance claimed this tick" --> S1([skip])
    O -- OK --> L{"SET lock:task:id token<br/>NX PX ttl"}
    L -- "not OK: previous run still going" --> S2([skip])
    L -- OK --> R[insert task_runs row, status running]
    R --> H[run handler with an AbortSignal]
    H --> HB{{"every ttl/3: extend lock<br/>if token still matches"}}
    HB -- "extend failed" --> AB[abort handler, mark lock_lost]
    H --> F[update task_runs: succeeded / failed / lock_lost]
    AB --> F
    F --> REL["release: Lua compare-and-delete"]
```

([`src/scheduler/scheduler.js`](src/scheduler/scheduler.js))

Each task uses **two keys**, because they solve different problems:

- **Occurrence key** (`sched:occurrence:<taskId>:<epochSecond>`) claims a single tick. Without it, a fast task could run twice for the same tick. Instance A runs it in 3 ms and releases the lock, then instance B's timer fires 5 ms later, finds the lock free, and runs it again. Timers on different machines fire a few ms apart, so the fire time is rounded to the nearest second to identify the tick.
- **Task lock** (`lock:task:<taskId>`) gives mutual exclusion. If a run is still going when the next tick fires, no instance starts a second, overlapping run.

**Long tasks.** While a handler runs, the lock is extended every `ttl/3`. The TTL therefore does not have to guess the longest possible run time. It only bounds how long a *crashed* instance can block the task. If an extension finds the token changed, or Redis has been unreachable for a full TTL, the handler's `AbortSignal` fires and the run is recorded as `lock_lost`.

**History.** Every execution is a row in `task_runs` (`server_id`, `status`, `error`, `started_at`, `finished_at`). `GET /tasks` combines this with the live lock holder from Redis.

**Graceful shutdown.** On `SIGTERM` or `SIGINT` the instance stops accepting HTTP connections and stops scheduling ticks. It waits up to `SHUTDOWN_TIMEOUT_MS` for running tasks, aborts the ones still running, releases their locks, and closes Postgres and Redis.

### Limits, stated honestly

- **Single Redis instance.** This is the single-node lock pattern, not Redlock. If Redis fails over to a replica that had not yet received the `SET`, two holders are possible.
- **A lock is not a fencing token.** A process that stalls past its TTL can still perform a side effect before it notices that the lock was lost. The abort signal shortens that window but cannot close it. If a task writes to a store where a duplicate would be harmful, that store should also reject stale writers (for example with a monotonically increasing fencing token or an idempotency key). Martin Kleppmann's ["How to do distributed locking"](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) explains this well.
- **At most once per tick.** If the instance that claimed a tick crashes mid-run, that tick is not retried. Its `task_runs` row stays `running`, while the Redis lock expires and the next tick proceeds normally.
- **Clocks.** Occurrence keys assume instance clocks agree to well under 500 ms (NTP).

---

## API

All bodies are JSON. Amounts are integers in minor units. Errors have the shape `{"error": {"code": "...", "message": "..."}}`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `POST` | `/users` | none | `201` new user with balance 0 | |
| `GET` | `/users/:id` | none | `200` `{id, balance, updatedAt}` | `400`, `404` |
| `POST` | `/users/:id/deposit` | `{"amount": 500}` | `200` updated user | `400`, `404` |
| `POST` | `/users/:id/withdraw` | `{"amount": 200}` | `200` updated user | `400`, `404`, `409 INSUFFICIENT_FUNDS` |
| `POST` | `/users/balance/update` | `{"userId": 1, "amount": -200}` | `200` updated user | as above |
| `GET` | `/tasks` | none | `200` tasks with `lastRun` and current `lockedBy` | |
| `GET` | `/tasks/:id/runs?limit=20` | none | `200` `{task, runs}` newest first | `400`, `404` |
| `GET` | `/health` | none | `200` `{"status":"ok"}` | `503` if Postgres or Redis is unreachable |

`POST /users/balance/update` is the endpoint from the original assignment, kept for compatibility. A positive `amount` deposits and a negative one withdraws.

Unexpected errors return `500 INTERNAL_ERROR` with a generic message. Details are logged on the server and never sent to the client.

```bash
curl -s localhost:3000/users/1
curl -s -X POST localhost:3000/users/1/withdraw -H 'content-type: application/json' -d '{"amount": 2500}'
curl -s -X POST localhost:3000/users/1/withdraw -H 'content-type: application/json' -d '{"amount": 99999999}'
# {"error":{"code":"INSUFFICIENT_FUNDS","message":"User 1 does not have 99999999 available"}}
curl -s localhost:3000/tasks
```

---

## Configuration

Environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `REDIS_URL` | required | Redis connection string |
| `PORT` | `3000` | HTTP port |
| `SERVER_ID` | hostname | Identifies the instance in lock values and `task_runs` |
| `SCHEDULER_ENABLED` | `true` | `false` runs an API-only instance |
| `LOCK_TTL_MS` | `30000` | Task lock TTL; renewed every TTL/3 while a task runs |
| `SEED_DEMO_DATA` | `false` | Insert user 1 (balance 10000) and three demo tasks on startup |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long shutdown waits for running tasks before aborting them |

Migrations in `src/db/migrations/*.sql` are applied on startup inside one transaction, under a Postgres advisory lock, so several instances starting at once do not race each other.

---

## Running it

### Docker (everything included)

```bash
docker compose up --build
```

This starts Postgres, Redis and **two app instances**, `app-1` on <http://localhost:3000> and `app-2` on <http://localhost:3001>, with demo data and a 5 s lock TTL. The demo tasks are `heartbeat` (every 5 s), `flaky-sync` (fails about 30% of the time) and `nightly-report` (takes 8 s, so its lock must be renewed). To watch the instances share the work:

```bash
docker compose logs -f app-1 app-2   # each tick is logged by exactly one instance
curl -s localhost:3000/tasks         # lockedBy / lastRun.serverId show who ran what
```

The image runs as the unprivileged `node` user and has a `HEALTHCHECK` on `/health`.

### Locally

Requires Node.js 22.9+ (24 recommended), plus Postgres and Redis.

```bash
npm install
cp .env.example .env    # adjust DATABASE_URL / REDIS_URL
npm run dev             # node --watch, loads .env
```

---

## Tests

```bash
npm test                  # unit tests, no external services needed
npm run test:integration  # opt-in, needs DATABASE_URL and/or REDIS_URL
```

### Unit tests (always run)

These need nothing beyond `npm install`:

- **Postgres is real, in-process.** [PGlite](https://pglite.dev) is Postgres compiled to WebAssembly. The tests plug it into the same small `db` interface the app uses (`query` / `exec` / `transaction`). The actual SQL, the migration, the `CHECK` constraint and the `RETURNING` clauses are all exercised, with no mocks and no ORM shims.
- **Redis is `ioredis-mock`**, which executes the Lua release and extend scripts.
- What they cover:
  - the lost-update interleaving, reproduced step by step, next to the atomic version refusing the second withdrawal;
  - the original GET-then-SET lock letting two servers in, next to `SET NX PX` letting one in;
  - a **lock contract suite**: exclusivity, TTL, expiry, owner-only release, the "late release must not delete the new owner's lock" case, owner-only extension, many contenders;
  - the scheduler: one run per tick across four instances, no overlapping runs, lock renewal during a task five times longer than the TTL, `lock_lost` with handler abort, failure recording, and graceful stop that waits and then aborts. It also starts two schedulers on real `cron` timers and checks that no tick runs twice;
  - the HTTP layer: status codes, validation, malformed JSON, the legacy endpoint, health and 503, and that 500s do not leak internals.

PGlite runs one statement at a time, so it checks the SQL semantics but not true parallelism. The integration tests cover that.

### Integration tests (opt-in)

Each suite is skipped unless its environment variable is set:

| Suite | Needs | What it proves |
|---|---|---|
| `balance.integration.test.js` | `DATABASE_URL` | 500 parallel withdrawals over a 20-connection pool: exactly the ones that fit succeed, the final balance matches, and no two requests debited from the same snapshot. Mixed parallel deposits and withdrawals add up. Plus a deterministic test: transaction A holds the row lock, B's withdrawal blocks, and after A commits B re-checks the guard and is refused. |
| `scheduler.integration.test.js` | `REDIS_URL` (+ `DATABASE_URL`) | The **same lock contract suite** against a real Redis, so the mock cannot quietly diverge. Then 10 schedulers on separate Redis connections race 20 ticks, and each tick runs exactly once. |

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/balance_test \
REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

The integration tests **truncate the app tables**, so point them at a throwaway database. The compose file does not publish the Postgres and Redis ports to the host. Use your own instances, or add `ports:` to those two services.

### CI

[GitHub Actions](.github/workflows/ci.yml) runs three jobs on every push and pull request:

1. unit tests;
2. integration tests against Postgres 17 and Redis 7 service containers;
3. `docker compose config` and a `docker build` of the image.

---

## Project layout

```
src/
  server.js                 entry point: wiring, migrations, graceful shutdown
  app.js                    Express app (built from injected services, so tests can swap backends)
  config.js                 environment parsing, fails fast on bad values
  errors.js                 AppError -> HTTP status + stable error code
  http/errorHandler.js      JSON errors, 404, no internals in 500s
  db/
    index.js                pg Pool behind a 4-method interface
    migrate.js              ordered SQL migrations under an advisory lock
    migrations/001_init.sql users, tasks, task_runs
    seed.js                 idempotent demo data
  balance/
    balanceService.js       the atomic withdraw/deposit statements + validation
    balanceRoutes.js
  scheduler/
    redisLock.js            SET NX PX acquire, Lua compare-and-delete release / extend
    scheduler.js            occurrence claim, lock, heartbeat, run history, stop()
    taskRepository.js       tasks + task_runs SQL
    handlers.js             demo task handlers
    taskRoutes.js
test/
  unit/                     PGlite + ioredis-mock, always run
  integration/              real Postgres / Redis, opt-in via env
  helpers/                  PGlite adapter, shared lock contract
```

---

## What changed from the original assignment

The original was Express + Sequelize + Umzug + `redis` + `cron`. Bugs found and fixed during the rework:

| Area | Bug | Effect |
|---|---|---|
| Balance | The controller passed a negative `amount` straight to `decreaseBalance`, which ran `balance - ${amount}` | Withdrawals **added** money (`balance - -300`). The `balance >= amount` guard compared against a negative number, so it never refused anything |
| Balance | "User not found" and "insufficient funds" were both thrown as plain `Error` | Every business error returned `500` |
| Balance | `amount` was interpolated into `Sequelize.literal(...)` | SQL was built from request input, and only the validator stood in the way |
| Balance | The validator required `joi`, which was not a declared dependency | It only worked because `express-validation` happened to pull `joi` in |
| Lock | GET, then SET without `NX` | Two servers could hold the same lock |
| Lock | No TTL | A crashed server blocked its tasks forever |
| Lock | Release was an unconditional `DEL` | A server could delete another server's lock |
| Scheduler | `endTask()` referenced an undefined `task` variable | The job's completion callback threw `ReferenceError`, so the history row never got an end time |
| Scheduler | The lock was taken once at startup, and that server kept the task for its whole lifetime | This was permanent ownership, not distribution. Because there was no TTL, no other server took over even after a crash |
| Scheduler | One history row per server start, not per run. The demo handler slept 120 s on a 5 s schedule | No per-run history, and runs overlapped on the same server |
| Startup | `redisClient.connect()` was not awaited. The DB port was ignored by the Sequelize config. Startup errors were logged, but the process did not exit | Half-started instances |
| Shutdown | No shutdown handling | Running tasks were killed mid-way and their locks were left behind |

The schema was redesigned as part of the rework (`users`, `tasks`, `task_runs`, snake_case columns, a `bigint` balance and a `CHECK` constraint). It is not a drop-in migration from the original tables.

---

## License

[MIT](LICENSE) © Guvanch D.
