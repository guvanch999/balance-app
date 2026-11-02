'use strict';

const { Pool } = require('pg');

/**
 * The rest of the code talks to Postgres through this small interface:
 *
 *   query(text, params) -> { rows, rowCount }   one parameterized statement
 *   exec(sql)                                   one or more statements, no params
 *   transaction(fn)                             fn(tx) runs inside BEGIN/COMMIT
 *   close()
 *
 * Keeping it this narrow means tests can plug in PGlite (Postgres compiled to
 * WebAssembly, running in-process) without touching the code under test.
 */
function wrapClient(client) {
  return {
    async query(text, params) {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

function createPostgresDb(connectionString, { max = 10 } = {}) {
  const pool = new Pool({ connectionString, max });

  return {
    ...wrapClient(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrapClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresDb };
