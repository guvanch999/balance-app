'use strict';

const { randomUUID } = require('node:crypto');

// Delete the key only if it still holds our token. Running GET and DEL as one
// Lua script makes the check-and-delete atomic: Redis executes scripts without
// interleaving other commands.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

// Same idea for renewing the TTL of a lock we still own.
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

/**
 * A single-instance Redis lock (the "SET NX PX + token" pattern).
 *
 * The only Redis capabilities it needs are `set(key, value, 'PX', ms, 'NX')`
 * and `eval(script, numKeys, ...keysAndArgs)`, which both ioredis and
 * ioredis-mock provide.
 */
class RedisLock {
  constructor(redis, { prefix = 'lock:', owner = 'unknown' } = {}) {
    this.redis = redis;
    this.prefix = prefix;
    this.owner = owner;
  }

  key(name) {
    return `${this.prefix}${name}`;
  }

  /**
   * Try to take the lock. Returns a token on success, or null if someone else
   * holds it. Never blocks or retries: for a scheduler "someone else is
   * already doing it" is an answer, not a failure.
   *
   * The token is unique per acquisition (owner prefix is only for humans
   * reading Redis). The TTL guarantees a crashed holder cannot keep the lock
   * forever.
   */
  async acquire(name, ttlMs) {
    assertTtl(ttlMs);
    const token = `${this.owner}:${randomUUID()}`;
    const result = await this.redis.set(this.key(name), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /** Release only if we still own the lock. Returns true if a key was deleted. */
  async release(name, token) {
    const deleted = await this.redis.eval(RELEASE_SCRIPT, 1, this.key(name), token);
    return Number(deleted) === 1;
  }

  /** Push the expiry out to ttlMs from now, only if we still own the lock. */
  async extend(name, token, ttlMs) {
    assertTtl(ttlMs);
    const extended = await this.redis.eval(EXTEND_SCRIPT, 1, this.key(name), token, ttlMs);
    return Number(extended) === 1;
  }

  /** Current token for a lock, or null. For status/diagnostics only. */
  async holder(name) {
    return this.redis.get(this.key(name));
  }
}

function assertTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`ttlMs must be a positive integer, got ${ttlMs}`);
  }
}

module.exports = { RedisLock, RELEASE_SCRIPT, EXTEND_SCRIPT };
