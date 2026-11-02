'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

/**
 * Demo task handlers, looked up by the `tasks.handler` column.
 *
 * Each handler receives `{ task, signal, logger }`. `signal` is aborted when
 * the scheduler loses the lock or shuts down; long-running handlers should
 * pass it to whatever they await so they stop promptly.
 */
const handlers = {
  async heartbeat({ task, logger }) {
    logger.info(`[${task.name}] tick`);
  },

  // Takes 8 s, longer than the 5 s LOCK_TTL_MS used in docker-compose.yml,
  // so the lock has to be renewed while it runs.
  async slowReport({ task, signal, logger }) {
    logger.info(`[${task.name}] building report...`);
    await sleep(8_000, undefined, { signal });
    logger.info(`[${task.name}] report done`);
  },

  async flaky({ task }) {
    if (Math.random() < 0.3) throw new Error(`${task.name}: upstream timed out (simulated)`);
  },
};

module.exports = { handlers };
