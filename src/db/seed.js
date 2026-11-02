'use strict';

/**
 * Demo data for local runs and docker compose. Idempotent and safe to run from
 * several instances at once: every insert is ON CONFLICT DO NOTHING.
 */
const DEMO_TASKS = [
  { name: 'heartbeat', schedule: '*/5 * * * * *', handler: 'heartbeat' },
  { name: 'nightly-report', schedule: '*/20 * * * * *', handler: 'slowReport' },
  { name: 'flaky-sync', schedule: '*/15 * * * * *', handler: 'flaky' },
];

async function seedDemoData(db, { logger = console } = {}) {
  await db.query(
    `INSERT INTO users (id, balance) VALUES (1, 10000)
     ON CONFLICT (id) DO NOTHING`,
  );
  // Identity columns do not advance when an explicit id is inserted.
  await db.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT max(id) FROM users), 1))`);

  for (const task of DEMO_TASKS) {
    await db.query(
      `INSERT INTO tasks (name, schedule, handler) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [task.name, task.schedule, task.handler],
    );
  }
  logger.info('demo data seeded (user 1, demo tasks)');
}

module.exports = { seedDemoData, DEMO_TASKS };
