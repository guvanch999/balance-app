'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const RedisMock = require('ioredis-mock');
const { createTestDb, silentLogger } = require('../helpers/db');
const { createBalanceService } = require('../../src/balance/balanceService');
const { createTaskRepository } = require('../../src/scheduler/taskRepository');
const { Scheduler } = require('../../src/scheduler/scheduler');
const { createApp } = require('../../src/app');

describe('HTTP API', () => {
  let db;
  let server;
  let baseUrl;
  let healthy = true;

  before(async () => {
    db = await createTestDb();
    const balanceService = createBalanceService(db);
    const taskRepository = createTaskRepository(db);
    const scheduler = new Scheduler({
      redis: new RedisMock(),
      taskRepository,
      handlers: {},
      serverId: 'test',
      logger: silentLogger,
    });
    await taskRepository.createTask({ name: 'demo', schedule: '*/5 * * * * *', handler: 'heartbeat' });

    const app = createApp({
      balanceService,
      scheduler,
      taskRepository,
      logger: silentLogger,
      healthCheck: async () => {
        if (!healthy) throw new Error('db down');
      },
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  async function call(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function newUser(balance) {
    const { body } = await call('POST', '/users');
    if (balance) await call('POST', `/users/${body.id}/deposit`, { amount: balance });
    return body.id;
  }

  it('creates a user, deposits and withdraws', async () => {
    const created = await call('POST', '/users');
    assert.equal(created.status, 201);
    assert.equal(created.body.balance, 0);
    const id = created.body.id;

    assert.equal((await call('POST', `/users/${id}/deposit`, { amount: 500 })).body.balance, 500);
    const withdrawn = await call('POST', `/users/${id}/withdraw`, { amount: 200 });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.balance, 300);
    assert.equal((await call('GET', `/users/${id}`)).body.balance, 300);
  });

  it('returns 409 INSUFFICIENT_FUNDS instead of overdrawing', async () => {
    const id = await newUser(100);
    const res = await call('POST', `/users/${id}/withdraw`, { amount: 101 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal((await call('GET', `/users/${id}`)).body.balance, 100);
  });

  it('returns 400 for invalid input', async () => {
    const id = await newUser(100);
    for (const amount of ['50', -5, 0, 1.5, undefined]) {
      const res = await call('POST', `/users/${id}/withdraw`, { amount });
      assert.equal(res.status, 400, `amount ${amount}`);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await call('GET', '/users/abc')).status, 400);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await fetch(`${baseUrl}/users/1/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"amount": ',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_REQUEST');
  });

  it('returns 404 for unknown users and routes', async () => {
    assert.equal((await call('POST', '/users/999999/withdraw', { amount: 1 })).status, 404);
    assert.equal((await call('GET', '/users/999999')).status, 404);
    assert.equal((await call('GET', '/nope')).status, 404);
  });

  describe('legacy POST /users/balance/update (original assignment contract)', () => {
    it('a negative amount withdraws (the original code added it instead)', async () => {
      const id = await newUser(1_000);
      const res = await call('POST', '/users/balance/update', { userId: id, amount: -300 });
      assert.equal(res.status, 200);
      assert.equal(res.body.balance, 700);
    });

    it('a positive amount deposits; overdraft and zero are rejected', async () => {
      const id = await newUser(100);
      assert.equal((await call('POST', '/users/balance/update', { userId: id, amount: 50 })).body.balance, 150);
      assert.equal((await call('POST', '/users/balance/update', { userId: id, amount: -151 })).status, 409);
      assert.equal((await call('POST', '/users/balance/update', { userId: id, amount: 0 })).status, 400);
    });
  });

  it('lists tasks and their run history', async () => {
    const tasks = await call('GET', '/tasks');
    assert.equal(tasks.status, 200);
    const demo = tasks.body.find((t) => t.name === 'demo');
    assert.deepEqual({ lockedBy: demo.lockedBy, lastRun: demo.lastRun }, { lockedBy: null, lastRun: null });

    const runs = await call('GET', `/tasks/${demo.id}/runs`);
    assert.equal(runs.status, 200);
    assert.deepEqual(runs.body.runs, []);
    assert.equal((await call('GET', '/tasks/424242/runs')).status, 404);
    assert.equal((await call('GET', `/tasks/${demo.id}/runs?limit=1000`)).status, 400);
  });

  it('reports health, and 503 when a dependency is down', async () => {
    assert.deepEqual(await call('GET', '/health'), { status: 200, body: { status: 'ok' } });
    healthy = false;
    try {
      assert.equal((await call('GET', '/health')).status, 503);
    } finally {
      healthy = true;
    }
  });
});

describe('error handler', () => {
  it('hides internal error details behind a generic 500', async () => {
    const failing = {
      createUser: async () => {
        throw new Error('connection to 10.0.0.5 refused, password=hunter2');
      },
    };
    const app = createApp({ balanceService: failing, logger: silentLogger });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/users`, { method: 'POST' });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
