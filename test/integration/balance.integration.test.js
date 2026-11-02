'use strict';

// Opt-in: runs only when DATABASE_URL points at a real Postgres. PGlite (used
// by the unit tests) executes one statement at a time; here a pool of real
// connections lets withdrawals genuinely race on the same row.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createIntegrationDb } = require('../helpers/db');
const { createBalanceService } = require('../../src/balance/balanceService');
const { InsufficientFundsError } = require('../../src/errors');

const skip = process.env.DATABASE_URL ? false : 'set DATABASE_URL to run Postgres integration tests';

describe('balance under real concurrency (Postgres)', { skip }, () => {
  let db;
  let service;

  before(async () => {
    db = await createIntegrationDb({ max: 20 });
    service = createBalanceService(db);
  });
  after(() => db?.close());

  async function userWith(balance) {
    return service.deposit((await service.createUser()).id, balance);
  }

  it('500 parallel withdrawals over 20 connections: no overdraft, no lost update', async () => {
    const user = await userWith(10_000);
    const results = await Promise.allSettled(Array.from({ length: 500 }, () => service.withdraw(user.id, 30)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.ok(
      refused.every((r) => r.reason instanceof InsufficientFundsError),
      'only insufficient-funds refusals are expected',
    );
    assert.equal(ok.length, Math.floor(10_000 / 30), 'every withdrawal that fits is accepted');

    const final = (await service.getUser(user.id)).balance;
    assert.equal(final, 10_000 - ok.length * 30, 'balance matches the accepted withdrawals exactly');
    assert.ok(final >= 0);

    // Each successful response saw a distinct balance: no two requests debited
    // from the same snapshot.
    const seen = ok.map((r) => r.value.balance);
    assert.equal(new Set(seen).size, seen.length);
  });

  it('mixed parallel deposits and withdrawals add up', async () => {
    const user = await userWith(1_000);
    const ops = Array.from({ length: 400 }, (_, i) =>
      i % 2 === 0 ? service.deposit(user.id, 10).then(() => 10) : service.withdraw(user.id, 25).then(() => -25),
    );
    const results = await Promise.allSettled(ops);
    const applied = results.filter((r) => r.status === 'fulfilled').reduce((sum, r) => sum + r.value, 0);
    assert.equal((await service.getUser(user.id)).balance, 1_000 + applied);
  });

  it('a withdrawal blocked behind another re-checks the guard against the committed balance', async () => {
    // Deterministic version of the race: transaction A debits 600 and holds the
    // row lock; B's withdrawal of 600 has to wait. When A commits, Postgres
    // re-evaluates B's WHERE clause on the new row (balance 400) and B updates
    // zero rows instead of overdrawing.
    const user = await userWith(1_000);
    const a = new Client({ connectionString: process.env.DATABASE_URL });
    await a.connect();
    try {
      await a.query('BEGIN');
      await a.query('UPDATE users SET balance = balance - 600 WHERE id = $1 AND balance >= 600', [user.id]);

      let settled = false;
      const b = service.withdraw(user.id, 600).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(settled, false, 'B must be blocked on the row lock');

      await a.query('COMMIT');
      await assert.rejects(b, InsufficientFundsError);
      assert.equal((await service.getUser(user.id)).balance, 400);
    } finally {
      await a.end();
    }
  });
});
