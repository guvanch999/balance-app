'use strict';

function toRun(row) {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    serverId: row.server_id,
    status: row.status,
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

function createTaskRepository(db) {
  return {
    async listEnabled() {
      const { rows } = await db.query(
        'SELECT id, name, schedule, handler FROM tasks WHERE enabled ORDER BY id',
      );
      return rows;
    },

    async getTask(id) {
      const { rows } = await db.query(
        'SELECT id, name, schedule, handler, enabled FROM tasks WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },

    async createTask({ name, schedule, handler, enabled = true }) {
      const { rows } = await db.query(
        `INSERT INTO tasks (name, schedule, handler, enabled) VALUES ($1, $2, $3, $4)
         RETURNING id, name, schedule, handler, enabled`,
        [name, schedule, handler, enabled],
      );
      return rows[0];
    },

    /** Every task with its most recent run (if any). */
    async listWithLastRun() {
      const { rows } = await db.query(
        `SELECT t.id, t.name, t.schedule, t.handler, t.enabled,
                r.id AS run_id, r.server_id, r.status, r.error, r.started_at, r.finished_at
           FROM tasks t
           LEFT JOIN LATERAL (
                SELECT * FROM task_runs
                 WHERE task_id = t.id
                 ORDER BY started_at DESC, id DESC
                 LIMIT 1
           ) r ON true
          ORDER BY t.id`,
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        schedule: row.schedule,
        handler: row.handler,
        enabled: row.enabled,
        lastRun: row.run_id == null ? null : toRun({ ...row, id: row.run_id, task_id: row.id }),
      }));
    },

    async listRuns(taskId, limit = 20) {
      const { rows } = await db.query(
        `SELECT id, task_id, server_id, status, error, started_at, finished_at
           FROM task_runs WHERE task_id = $1
          ORDER BY started_at DESC, id DESC
          LIMIT $2`,
        [taskId, limit],
      );
      return rows.map(toRun);
    },

    async startRun(taskId, serverId) {
      const { rows } = await db.query(
        `INSERT INTO task_runs (task_id, server_id, status) VALUES ($1, $2, 'running')
         RETURNING id`,
        [taskId, serverId],
      );
      return Number(rows[0].id);
    },

    async finishRun(runId, status, error = null) {
      await db.query(
        'UPDATE task_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1',
        [runId, status, error],
      );
    },
  };
}

module.exports = { createTaskRepository };
