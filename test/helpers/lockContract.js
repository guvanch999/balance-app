'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { RedisLock } = require('../../src/scheduler/redisLock');

/**
 * Behaviour every backend must have for RedisLock to be correct. Runs against
 * ioredis-mock in the unit suite and against a real Redis in the integration
 * suite, so the mock cannot quietly diverge from the real thing.
 *
 * @param {string} label
 * @param {() => import('ioredis').Redis} newClient  returns a new client (one per "server")
 */
function lockContract(label, newClient) {
  describe(`RedisLock contract (${label})`, () => {
    let redis;
    const name = 'contract-test';
    const clients = [];
    const createClient = () => {
      const client = newClient();
      clients.push(client);
      return client;
    };

    after(() => Promise.all(clients.map((client) => client.quit())));

    before(() => {
      redis = createClient();
    });
    beforeEach(() => redis.del(`lock:${name}`));

    it('grants the lock to one holder and refuses the next', async () => {
      const a = new RedisLock(redis, { owner: 'a' });
      const b = new RedisLock(redis, { owner: 'b' });

      const tokenA = await a.acquire(name, 5_000);
      assert.ok(tokenA, 'first acquire should succeed');
      assert.match(tokenA, /^a:/);
      assert.equal(await b.acquire(name, 5_000), null);
      assert.equal(await a.acquire(name, 5_000), null, 'not re-entrant');
    });

    it('sets a TTL so a crashed holder cannot block forever', async () => {
      const a = new RedisLock(redis, { owner: 'a' });
      await a.acquire(name, 5_000);
      const ttl = await redis.pttl(`lock:${name}`);
      assert.ok(ttl > 0 && ttl <= 5_000, `expected a TTL, got ${ttl}`);
    });

    it('becomes available again after the TTL expires', async () => {
      const a = new RedisLock(redis, { owner: 'a' });
      const b = new RedisLock(redis, { owner: 'b' });
      assert.ok(await a.acquire(name, 50));
      await sleep(120);
      assert.ok(await b.acquire(name, 5_000));
    });

    it('releases only with the matching token', async () => {
      const a = new RedisLock(redis, { owner: 'a' });
      const token = await a.acquire(name, 5_000);

      assert.equal(await a.release(name, 'a:not-my-token'), false);
      assert.equal(await a.holder(name), token, 'wrong token must not delete the key');

      assert.equal(await a.release(name, token), true);
      assert.equal(await a.holder(name), null);
      assert.equal(await a.release(name, token), false, 'second release is a no-op');
    });

    it('does not delete a lock that expired and was taken by someone else', async () => {
      // The classic bug with a plain DEL: A stalls past its TTL, B acquires,
      // A wakes up and "releases", deleting B's lock.
      const a = new RedisLock(redis, { owner: 'a' });
      const b = new RedisLock(redis, { owner: 'b' });

      const tokenA = await a.acquire(name, 50);
      await sleep(120);
      const tokenB = await b.acquire(name, 5_000);
      assert.ok(tokenB);

      assert.equal(await a.release(name, tokenA), false);
      assert.equal(await b.holder(name), tokenB, "B's lock must survive A's late release");
    });

    it('extends only while the caller still owns the lock', async () => {
      const a = new RedisLock(redis, { owner: 'a' });
      const b = new RedisLock(redis, { owner: 'b' });

      const tokenA = await a.acquire(name, 100);
      assert.equal(await a.extend(name, tokenA, 5_000), true);
      assert.ok((await redis.pttl(`lock:${name}`)) > 1_000, 'TTL should have been pushed out');
      assert.equal(await b.extend(name, 'b:forged', 5_000), false);

      await a.release(name, tokenA);
      assert.equal(await a.extend(name, tokenA, 5_000), false, 'cannot extend a released lock');
    });

    it('lets exactly one of many concurrent contenders win', async () => {
      const contenders = Array.from({ length: 8 }, (_, i) => new RedisLock(createClient(), { owner: `s${i}` }));
      const tokens = await Promise.all(contenders.map((lock) => lock.acquire(name, 5_000)));
      assert.equal(tokens.filter(Boolean).length, 1);
    });
  });
}

module.exports = { lockContract };
