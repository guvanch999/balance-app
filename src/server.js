'use strict';

const Redis = require('ioredis');
const { loadConfig } = require('./config');
const { createPostgresDb } = require('./db');
const { migrate } = require('./db/migrate');
const { seedDemoData } = require('./db/seed');
const { createBalanceService } = require('./balance/balanceService');
const { createTaskRepository } = require('./scheduler/taskRepository');
const { Scheduler } = require('./scheduler/scheduler');
const { handlers } = require('./scheduler/handlers');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const logger = console;

  const db = createPostgresDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on('error', (err) => logger.error('redis error:', err.message));

  await redis.ping();
  await migrate(db, { logger });
  if (config.seedDemoData) await seedDemoData(db, { logger });

  const balanceService = createBalanceService(db);
  const taskRepository = createTaskRepository(db);
  const scheduler = new Scheduler({
    redis,
    taskRepository,
    handlers,
    serverId: config.serverId,
    lockTtlMs: config.scheduler.lockTtlMs,
    logger,
  });

  const app = createApp({
    balanceService,
    scheduler,
    taskRepository,
    logger,
    healthCheck: async () => {
      await db.query('SELECT 1');
      await redis.ping();
    },
  });

  const server = app.listen(config.port, () => {
    logger.info(`server ${config.serverId} listening on port ${config.port}`);
  });

  if (config.scheduler.enabled) await scheduler.start();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);

    // Last resort if something refuses to close.
    setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs + 5_000).unref();

    try {
      // Stop taking requests and stop scheduling ticks; let in-flight work finish.
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        scheduler.stop({ timeoutMs: config.shutdownTimeoutMs }),
      ]);
      await redis.quit();
      await db.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('error during shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('failed to start:', error);
  process.exit(1);
});
