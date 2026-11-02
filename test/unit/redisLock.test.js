'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const RedisMock = require('ioredis-mock');
const { RedisLock } = require('../../src/scheduler/redisLock');
const { lockContract } = require('../helpers/lockContract');

// ioredis-mock instances share one in-memory keyspace, like several app
// servers sharing one Redis. It also runs Lua (via fengari), so the release
// and extend scripts are executed for real.
lockContract('ioredis-mock', () => new RedisMock());

describe('RedisLock input validation', () => {
  it('rejects a missing or non-positive TTL', async () => {
    const lock = new RedisLock(new RedisMock(), { owner: 'a' });
    await assert.rejects(lock.acquire('x'), TypeError);
    await assert.rejects(lock.acquire('x', 0), TypeError);
    await assert.rejects(lock.extend('x', 'token', -1), TypeError);
  });
});

describe('why the original GET-then-SET lock was broken', () => {
  // Faithful copy of the original tryLockTask(): check, then write, as two
  // separate round trips, with no NX and no expiry.
  async function originalTryLock(redis, taskId, serverId) {
    const current = await redis.get(`task_lock:${taskId}`);
    if (current) return false;
    return (await redis.set(`task_lock:${taskId}`, serverId)) === 'OK';
  }

  it('lets two servers both believe they hold the lock', async () => {
    const redis = new RedisMock();
    await redis.flushall();
    // Both servers start at the same moment: both GETs run before either SET.
    const results = await Promise.all([
      originalTryLock(redis, 1, 'server-a'),
      originalTryLock(redis, 1, 'server-b'),
    ]);
    assert.deepEqual(results, [true, true], 'both acquired: mutual exclusion is broken');
    assert.equal(await redis.pttl('task_lock:1'), -1, 'and the key never expires');
  });

  it('is fixed by a single SET NX PX', async () => {
    const redis = new RedisMock();
    await redis.flushall();
    const a = new RedisLock(redis, { owner: 'server-a' });
    const b = new RedisLock(redis, { owner: 'server-b' });
    const results = await Promise.all([a.acquire('task:1', 5_000), b.acquire('task:1', 5_000)]);
    assert.equal(results.filter(Boolean).length, 1);
  });
});
