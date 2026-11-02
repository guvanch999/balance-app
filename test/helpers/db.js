'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { createPostgresDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Same interface as src/db (query / exec / transaction / close), backed by
 * PGlite: real Postgres compiled to WebAssembly, in-process, no server needed.
 * PGlite is single-connection, so statements run one at a time; it checks SQL
 * semantics, not true parallelism. See test/integration for that.
 */
function wrapPGlite(handle) {
  return {
    async query(text, params) {
      const result = await handle.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql) {
      await handle.exec(sql);
    },
  };
}

async function createTestDb() {
  const pg = await PGlite.create();
  const db = {
    ...wrapPGlite(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrapPGlite(tx))),
    close: () => pg.close(),
  };
  await migrate(db, { logger: silentLogger });
  return db;
}

/**
 * Real Postgres from DATABASE_URL, migrated, with app tables emptied. Used by
 * the opt-in integration tests.
 */
async function createIntegrationDb({ max = 20 } = {}) {
  const db = createPostgresDb(process.env.DATABASE_URL, { max });
  await migrate(db, { logger: silentLogger });
  await db.exec('TRUNCATE task_runs, tasks, users RESTART IDENTITY CASCADE');
  return db;
}

module.exports = { createTestDb, createIntegrationDb, silentLogger };
