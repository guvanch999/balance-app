'use strict';

const express = require('express');
const { balanceRoutes, legacyBalanceRoute } = require('./balance/balanceRoutes');
const { taskRoutes } = require('./scheduler/taskRoutes');
const { errorHandler, notFoundHandler } = require('./http/errorHandler');

/**
 * Builds the Express app from already-constructed services, so tests can pass
 * in services backed by PGlite / ioredis-mock.
 */
function createApp({ balanceService, scheduler, taskRepository, healthCheck, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // Liveness + dependency check: 503 if Postgres or Redis is unreachable.
  app.get('/health', async (req, res) => {
    try {
      if (healthCheck) await healthCheck();
      res.json({ status: 'ok' });
    } catch (error) {
      logger.warn('health check failed:', error.message);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.post('/users/balance/update', legacyBalanceRoute(balanceService));
  app.use('/users', balanceRoutes(balanceService));
  app.use('/tasks', taskRoutes({ scheduler, taskRepository }));

  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));
  return app;
}

module.exports = { createApp };
