'use strict';

const { NotFoundError, InsufficientFundsError, ValidationError } = require('../errors');

/** Largest single deposit/withdrawal, in minor units (10,000,000.00). */
const MAX_AMOUNT = 1_000_000_000;

function parseAmount(value) {
  // Require a real JSON number: "100" or 100.5 are rejected rather than coerced.
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_AMOUNT) {
    throw new ValidationError(`amount must be an integer between 1 and ${MAX_AMOUNT} (minor units)`, {
      field: 'amount',
    });
  }
  return value;
}

function parseUserId(value) {
  const id = typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ValidationError('userId must be a positive integer', { field: 'userId' });
  }
  return id;
}

function toUser(row) {
  // pg returns bigint columns as strings; amounts here stay far below 2^53.
  return { id: Number(row.id), balance: Number(row.balance), updatedAt: row.updated_at };
}

function createBalanceService(db) {
  async function exists(userId) {
    const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    return rows.length > 0;
  }

  return {
    async createUser() {
      const { rows } = await db.query('INSERT INTO users DEFAULT VALUES RETURNING id, balance, updated_at');
      return toUser(rows[0]);
    },

    async getUser(userId) {
      const id = parseUserId(userId);
      const { rows } = await db.query('SELECT id, balance, updated_at FROM users WHERE id = $1', [id]);
      if (rows.length === 0) throw new NotFoundError(`User ${id} not found`);
      return toUser(rows[0]);
    },

    async deposit(userId, amount) {
      const id = parseUserId(userId);
      const value = parseAmount(amount);
      const { rows } = await db.query(
        `UPDATE users
            SET balance = balance + $2, updated_at = now()
          WHERE id = $1
      RETURNING id, balance, updated_at`,
        [id, value],
      );
      if (rows.length === 0) throw new NotFoundError(`User ${id} not found`);
      return toUser(rows[0]);
    },

    /**
     * The whole check-and-debit is ONE statement. Postgres takes a row lock for
     * the UPDATE and re-evaluates `balance >= $2` against the latest committed
     * row, so concurrent withdrawals queue up on that row instead of reading a
     * stale balance. There is no window between "check" and "write" for another
     * request to slip into, and therefore no lost update and no overdraft.
     */
    async withdraw(userId, amount) {
      const id = parseUserId(userId);
      const value = parseAmount(amount);
      const { rows } = await db.query(
        `UPDATE users
            SET balance = balance - $2, updated_at = now()
          WHERE id = $1 AND balance >= $2
      RETURNING id, balance, updated_at`,
        [id, value],
      );
      if (rows.length === 1) return toUser(rows[0]);

      // Zero rows updated: either the user does not exist or the guard failed.
      // This extra read only picks the right error; it does not affect money.
      if (await exists(id)) throw new InsufficientFundsError(id, value);
      throw new NotFoundError(`User ${id} not found`);
    },
  };
}

module.exports = { createBalanceService, parseAmount, parseUserId, MAX_AMOUNT };
