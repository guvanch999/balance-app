'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Arbitrary constant shared by every instance. Several app instances may start
// at the same time (e.g. `docker compose up` with two replicas); the advisory
// lock makes them apply migrations one after another instead of racing.
const MIGRATION_LOCK_KEY = 727_001;

/**
 * Applies pending `src/db/migrations/*.sql` files in filename order.
 * Everything runs in one transaction (Postgres DDL is transactional), so a
 * failing migration leaves the schema untouched.
 */
async function migrate(db, { logger = console } = {}) {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await tx.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));

    for (const name of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      logger.info(`migration applied: ${name}`);
    }
    return pending;
  });
}

module.exports = { migrate };
