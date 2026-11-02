'use strict';

const express = require('express');
const { NotFoundError, ValidationError } = require('../errors');

function taskRoutes({ scheduler, taskRepository }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.json(await scheduler.status());
  });

  router.get('/:taskId/runs', async (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new ValidationError('taskId must be a positive integer', { field: 'taskId' });
    }
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError('limit must be an integer between 1 and 100', { field: 'limit' });
    }
    const task = await taskRepository.getTask(taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    res.json({ task, runs: await taskRepository.listRuns(taskId, limit) });
  });

  return router;
}

module.exports = { taskRoutes };
