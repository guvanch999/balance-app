'use strict';

// Opt-in: runs against a real Redis (REDIS_URL) and, for the scheduler part,
// a real Postgres (DATABASE_URL). The same lock contract the unit suite runs
// on ioredis-mock is executed here, so the mock and Redis cannot drift apart.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { lockContract } = require('../helpers/lockContract');
const { createIntegrationDb, silentLogger } = require('../helpers/db');
const { createTaskRepository } = require('../../src/scheduler/taskRepository');
const { Scheduler } = require('../../src/scheduler/scheduler');

const { REDIS_URL, DATABASE_URL } = process.env;

if (REDIS_URL) {
  lockContract('real Redis', () => new Redis(REDIS_URL));
} else {
  it('RedisLock contract (real Redis)', { skip: 'set REDIS_URL to run Redis integration tests' }, () => {});
}

const skip = REDIS_URL && DATABASE_URL ? false : 'set REDIS_URL and DATABASE_URL to run scheduler integration tests';

describe('scheduler across separate Redis connections (Redis + Postgres)', { skip }, () => {
  let db;
  let repo;
  const clients = [];

  before(async () => {
    db = await createIntegrationDb();
    repo = createTaskRepository(db);
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await db?.close();
  });

  it('10 servers x 20 ticks: every tick runs exactly once', async () => {
    let executions = 0;
    const handlers = {
      count: async () => {
        executions += 1;
      },
    };
    const task = await repo.createTask({ name: 'integration-count', schedule: '* * * * * *', handler: 'count' });
    const servers = Array.from({ length: 10 }, (_, i) => {
      const redis = new Redis(REDIS_URL);
      clients.push(redis);
      return new Scheduler({ redis, taskRepository: repo, handlers, serverId: `s${i}`, logger: silentLogger });
    });
    await clients[0].del(...Array.from({ length: 20 }, (_, t) => `sched:occurrence:${task.id}:${1_000 + t}`));

    for (let tick = 0; tick < 20; tick += 1) {
      const firedAt = (1_000 + tick) * 1_000;
      const outcomes = await Promise.all(servers.map((s, i) => s.runOccurrence(task, firedAt + i)));
      assert.equal(outcomes.filter((o) => o.outcome === 'succeeded').length, 1, `tick ${tick}`);
    }

    assert.equal(executions, 20);
    assert.equal((await repo.listRuns(task.id, 100)).length, 20);
  });
});
