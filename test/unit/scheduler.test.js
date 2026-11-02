'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const RedisMock = require('ioredis-mock');
const { createTestDb, silentLogger } = require('../helpers/db');
const { createTaskRepository } = require('../../src/scheduler/taskRepository');
const { Scheduler } = require('../../src/scheduler/scheduler');

/** A promise plus its resolve function, to hold a handler "mid-run". */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('Scheduler (ioredis-mock + PGlite)', () => {
  let db;
  let repo;
  let redis;
  let calls;
  let handlers;
  let n = 0;

  before(async () => {
    db = await createTestDb();
    repo = createTaskRepository(db);
    redis = new RedisMock();
  });
  after(() => db.close());

  beforeEach(async () => {
    await redis.flushall();
    calls = [];
    handlers = {
      record: async ({ task }) => {
        calls.push(task.id);
      },
    };
  });

  function server(serverId, options = {}) {
    return new Scheduler({
      redis,
      taskRepository: repo,
      handlers,
      serverId,
      lockTtlMs: 1_000,
      logger: silentLogger,
      ...options,
    });
  }

  async function newTask(handler = 'record', schedule = '*/5 * * * * *') {
    n += 1;
    return repo.createTask({ name: `task-${n}`, schedule, handler });
  }

  it('runs each scheduled tick on exactly one server', async () => {
    const task = await newTask();
    const servers = ['a', 'b', 'c', 'd'].map((id) => server(id));
    const firedAt = Date.parse('2026-01-01T00:00:05.000Z');

    // Every server's timer fires within a few ms of the scheduled time.
    const outcomes = await Promise.all(servers.map((s, i) => s.runOccurrence(task, firedAt + i * 7)));

    assert.equal(outcomes.filter((o) => o.outcome === 'succeeded').length, 1);
    assert.equal(outcomes.filter((o) => o.outcome === 'claimed-elsewhere').length, 3);
    assert.deepEqual(calls, [task.id]);

    const runs = await repo.listRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
    assert.ok(['a', 'b', 'c', 'd'].includes(runs[0].serverId));
    assert.ok(runs[0].finishedAt);
  });

  it('does not start an overlapping run while the previous one is still going', async () => {
    const task = await newTask('slow');
    const held = gate();
    handlers.slow = () => held.promise;
    const a = server('a');
    const b = server('b');

    const first = a.runOccurrence(task, 10_000);
    await sleep(20); // let A take the lock
    assert.deepEqual(await b.runOccurrence(task, 15_000), { outcome: 'already-running' });

    const [status] = (await b.status()).filter((t) => t.id === task.id);
    assert.equal(status.lockedBy, 'a');
    assert.equal(status.lastRun.status, 'running');

    held.open();
    assert.equal((await first).outcome, 'succeeded');
    assert.equal((await b.runOccurrence(task, 20_000)).outcome, 'succeeded', 'next tick runs normally');
  });

  it('records failures and still releases the lock', async () => {
    const task = await newTask('boom');
    handlers.boom = async () => {
      throw new Error('upstream exploded');
    };
    const a = server('a');

    const result = await a.runOccurrence(task, 30_000);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error, 'upstream exploded');
    assert.equal(await redis.get(`lock:task:${task.id}`), null);

    const [run] = await repo.listRuns(task.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'upstream exploded');
  });

  it('keeps extending the lock while a long task runs', async () => {
    const task = await newTask('long');
    handlers.long = () => sleep(400); // 5x the TTL below
    const a = server('a', { lockTtlMs: 80 });
    const b = server('b', { lockTtlMs: 80 });

    const run = a.runOccurrence(task, 40_000);
    for (let i = 0; i < 6; i += 1) {
      await sleep(50);
      assert.equal((await b.runOccurrence(task, 41_000 + i * 1_000)).outcome, 'already-running');
    }
    assert.equal((await run).outcome, 'succeeded');
  });

  it('aborts the handler and records lock_lost if the lock is taken away', async () => {
    const task = await newTask('waits');
    let abortReason;
    handlers.waits = ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortReason = signal.reason;
          reject(signal.reason);
        });
      });
    const a = server('a', { lockTtlMs: 90 });

    const run = a.runOccurrence(task, 50_000);
    await sleep(20);
    // Simulate A stalling past its TTL (GC pause, network partition) while
    // another server takes the lock.
    await redis.set(`lock:task:${task.id}`, 'b:other-token', 'PX', 5_000);

    const result = await run;
    assert.equal(result.outcome, 'lock_lost');
    assert.equal(abortReason?.name, 'LockLostError');
    assert.equal(await redis.get(`lock:task:${task.id}`), 'b:other-token', "A must not release B's lock");
    assert.equal((await repo.listRuns(task.id))[0].status, 'lock_lost');
  });

  it('on stop(), waits for running tasks, then aborts the ones that overrun', async () => {
    const quick = await newTask('quick');
    const stuck = await newTask('stuck');
    handlers.quick = () => sleep(50);
    handlers.stuck = ({ signal }) => sleep(60_000, undefined, { signal });
    const a = server('a');

    const quickRun = a.trigger(quick, 60_000);
    const stuckRun = a.trigger(stuck, 60_000);
    await sleep(10);

    const started = Date.now();
    await a.stop({ timeoutMs: 200 });
    assert.ok(Date.now() - started < 2_000);

    assert.equal((await quickRun).outcome, 'succeeded');
    const stuckResult = await stuckRun;
    assert.equal(stuckResult.outcome, 'failed');
    assert.equal(stuckResult.error, 'scheduler is shutting down');
    assert.equal(await redis.get(`lock:task:${stuck.id}`), null, 'lock released on shutdown');
    assert.deepEqual(await a.runOccurrence(quick, 70_000), { outcome: 'stopping' });
  });

  it('with real cron timers, two servers never run the same tick twice', async () => {
    const task = await newTask('record', '* * * * * *'); // every second
    const a = server('a');
    const b = server('b');
    // Only schedule our task: other tests' tasks live in the same database.
    const only = { listEnabled: async () => [task] };
    a.repo = { ...repo, ...only };
    b.repo = { ...repo, ...only };

    await Promise.all([a.start(), b.start()]);
    await sleep(3_200);
    await Promise.all([a.stop(), b.stop()]);

    const runs = await repo.listRuns(task.id, 100);
    const seconds = runs.map((r) => Math.round(new Date(r.startedAt).getTime() / 1000));
    assert.ok(runs.length >= 2 && runs.length <= 4, `expected one run per tick, got ${runs.length}`);
    assert.equal(new Set(seconds).size, runs.length, 'no tick ran twice');
  });

  it('skips tasks with an unknown handler or an invalid schedule', async () => {
    const warnings = [];
    const a = server('a', { logger: { ...silentLogger, warn: (msg) => warnings.push(msg) } });
    a.repo = {
      ...repo,
      listEnabled: async () => [
        { id: 900, name: 'ghost', schedule: '* * * * *', handler: 'missing' },
        { id: 901, name: 'typo', schedule: 'every minute', handler: 'record' },
      ],
    };
    await a.start();
    assert.equal(a.jobs.length, 0);
    assert.equal(warnings.length, 2);
    await a.stop();
  });
});
