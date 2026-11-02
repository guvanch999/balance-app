'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/db');
const { createBalanceService, parseAmount, parseUserId, MAX_AMOUNT } = require('../../src/balance/balanceService');
const { InsufficientFundsError, NotFoundError, ValidationError } = require('../../src/errors');

describe('input validation', () => {
  it('accepts positive integer amounts up to the limit', () => {
    assert.equal(parseAmount(1), 1);
    assert.equal(parseAmount(MAX_AMOUNT), MAX_AMOUNT);
  });

  for (const bad of [0, -5, 1.5, '100', null, undefined, NaN, Infinity, MAX_AMOUNT + 1, {}]) {
    it(`rejects amount ${JSON.stringify(bad) ?? String(bad)}`, () => {
      assert.throws(() => parseAmount(bad), ValidationError);
    });
  }

  it('parses user ids from route params and JSON bodies', () => {
    assert.equal(parseUserId('42'), 42);
    assert.equal(parseUserId(42), 42);
    for (const bad of ['0', '-1', '1.5', 'abc', '01', '', 0, 1.5, null]) {
      assert.throws(() => parseUserId(bad), ValidationError, `should reject ${bad}`);
    }
  });
});

describe('balance service (PGlite, in-process Postgres)', () => {
  let db;
  let service;

  before(async () => {
    db = await createTestDb();
    service = createBalanceService(db);
  });
  after(() => db.close());

  async function userWith(balance) {
    const user = await service.createUser();
    return balance > 0 ? service.deposit(user.id, balance) : user;
  }

  it('creates users with a zero balance', async () => {
    const user = await service.createUser();
    assert.equal(user.balance, 0);
    assert.deepEqual(await service.getUser(String(user.id)), user);
  });

  it('deposits and withdraws', async () => {
    const user = await userWith(1_000);
    assert.equal((await service.withdraw(user.id, 300)).balance, 700);
    assert.equal((await service.deposit(user.id, 50)).balance, 750);
  });

  it('allows withdrawing the exact balance', async () => {
    const user = await userWith(500);
    assert.equal((await service.withdraw(user.id, 500)).balance, 0);
  });

  it('refuses to overdraw and leaves the balance untouched', async () => {
    const user = await userWith(100);
    await assert.rejects(service.withdraw(user.id, 101), InsufficientFundsError);
    assert.equal((await service.getUser(user.id)).balance, 100);
  });

  it('distinguishes an unknown user from insufficient funds', async () => {
    await assert.rejects(service.withdraw(999_999, 1), NotFoundError);
    await assert.rejects(service.deposit(999_999, 1), NotFoundError);
    await assert.rejects(service.getUser(999_999), NotFoundError);
  });

  it('never goes negative across many withdrawals fired at once', async () => {
    // PGlite executes statements one at a time, so this checks the guard in
    // the SQL, not real parallelism; test/integration does that on Postgres.
    const user = await userWith(1_000);
    const results = await Promise.allSettled(Array.from({ length: 200 }, () => service.withdraw(user.id, 7)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.ok(refused.every((r) => r.reason instanceof InsufficientFundsError));
    assert.ok(ok.every((r) => r.value.balance >= 0));
    assert.equal(ok.length, Math.floor(1_000 / 7));
    assert.equal((await service.getUser(user.id)).balance, 1_000 - ok.length * 7);
  });

  it('has a CHECK constraint as a second line of defence', async () => {
    const user = await userWith(10);
    await assert.rejects(
      db.query('UPDATE users SET balance = balance - 11 WHERE id = $1', [user.id]),
      /balance_non_negative/,
    );
  });
});

describe('the lost-update problem', () => {
  let db;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  // Read-modify-write split across two round trips: the pattern this project
  // replaces. Steps are driven by hand to reproduce one bad interleaving
  // deterministically.
  it('a read-then-write withdrawal loses an update when two requests interleave', async () => {
    const { rows } = await db.query('INSERT INTO users (balance) VALUES (100) RETURNING id');
    const id = rows[0].id;
    const read = async () => Number((await db.query('SELECT balance FROM users WHERE id = $1', [id])).rows[0].balance);
    const write = (balance) => db.query('UPDATE users SET balance = $2 WHERE id = $1', [id, balance]);

    const seenByA = await read(); // A: 100, enough for 60
    const seenByB = await read(); // B: 100, enough for 60
    await write(seenByA - 60); // A: 40
    await write(seenByB - 60); // B: 40, overwriting A

    const final = await read();
    assert.equal(final, 40, '120 was paid out but only 60 was debited');
  });

  it('the single-statement withdrawal cannot be split, so the second one is refused', async () => {
    const service = createBalanceService(db);
    const user = await service.deposit((await service.createUser()).id, 100);

    const [a, b] = await Promise.allSettled([service.withdraw(user.id, 60), service.withdraw(user.id, 60)]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.ok(b.reason instanceof InsufficientFundsError);
    assert.equal((await service.getUser(user.id)).balance, 40);
  });
});
