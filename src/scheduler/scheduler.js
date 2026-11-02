'use strict';

const { CronJob, validateCronExpression } = require('cron');
const { RedisLock } = require('./redisLock');

class LockLostError extends Error {
  constructor(lockName) {
    super(`lock "${lockName}" was lost before the task finished`);
    this.name = 'LockLostError';
  }
}

class ShutdownError extends Error {
  constructor() {
    super('scheduler is shutting down');
    this.name = 'ShutdownError';
  }
}

/**
 * Distributed cron: every instance schedules every task, and Redis decides
 * which instance actually runs a given tick.
 *
 * Two keys are involved per task:
 *
 *  1. occurrence key  `sched:occurrence:<taskId>:<epochSecond>` (SET NX PX)
 *     Claims one scheduled tick. Without it, a fast task could run twice for
 *     the same tick: instance A runs and releases the lock, then instance B,
 *     whose timer fired a few ms later, finds the lock free and runs again.
 *
 *  2. task lock       `lock:task:<taskId>` (RedisLock, renewed while running)
 *     Mutual exclusion. If a run is still going when the next tick fires,
 *     nobody starts a second, overlapping run.
 */
class Scheduler {
  constructor({
    redis,
    taskRepository,
    handlers,
    serverId,
    lockTtlMs = 30_000,
    occurrenceTtlMs = 60_000,
    logger = console,
  }) {
    this.redis = redis;
    this.repo = taskRepository;
    this.handlers = handlers;
    this.serverId = serverId;
    this.lockTtlMs = lockTtlMs;
    this.occurrenceTtlMs = occurrenceTtlMs;
    this.logger = logger;
    this.lock = new RedisLock(redis, { prefix: 'lock:', owner: serverId });
    this.jobs = [];
    this.inFlight = new Set();
    this.controllers = new Set();
    this.stopping = false;
  }

  /** Load enabled tasks from the database and start one cron job per task. */
  async start() {
    const tasks = await this.repo.listEnabled();
    for (const task of tasks) {
      if (!this.handlers[task.handler]) {
        this.logger.warn(`task "${task.name}": unknown handler "${task.handler}", skipped`);
        continue;
      }
      if (!validateCronExpression(task.schedule).valid) {
        this.logger.warn(`task "${task.name}": invalid schedule "${task.schedule}", skipped`);
        continue;
      }
      this.jobs.push(
        CronJob.from({
          cronTime: task.schedule,
          onTick: () => {
            this.trigger(task);
          },
          start: true,
          name: task.name,
        }),
      );
    }
    this.logger.info(`scheduler on ${this.serverId}: ${this.jobs.length} task(s) scheduled`);
  }

  /** Fire-and-forget entry point used by cron; tracks the run for shutdown. */
  trigger(task, firedAt = Date.now()) {
    const run = this.runOccurrence(task, firedAt)
      .catch((error) => {
        this.logger.error(`task "${task.name}" crashed the scheduler run:`, error);
        return { outcome: 'error', error };
      })
      .finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
    return run;
  }

  /** Handle one scheduled tick of `task`. Resolves to a description of what happened. */
  async runOccurrence(task, firedAt = Date.now()) {
    if (this.stopping) return { outcome: 'stopping' };

    // Timers on different instances fire a few ms apart; rounding to the
    // nearest second maps them to the same occurrence. Assumes clocks are
    // NTP-synced to well under 500 ms.
    const occurrence = Math.round(firedAt / 1000);
    const claimed = await this.redis.set(
      `sched:occurrence:${task.id}:${occurrence}`,
      this.serverId,
      'PX',
      this.occurrenceTtlMs,
      'NX',
    );
    if (claimed !== 'OK') return { outcome: 'claimed-elsewhere' };

    return this.runExclusive(task);
  }

  /** Run `task` if, and only while, we hold its lock. */
  async runExclusive(task) {
    const handler = this.handlers[task.handler];
    if (!handler) throw new Error(`unknown handler "${task.handler}"`);

    const lockName = `task:${task.id}`;
    const token = await this.lock.acquire(lockName, this.lockTtlMs);
    if (!token) return { outcome: 'already-running' };

    const controller = new AbortController();
    this.controllers.add(controller);
    const heartbeat = this.#startHeartbeat(lockName, token, controller);

    try {
      const runId = await this.repo.startRun(task.id, this.serverId);
      let status = 'succeeded';
      let error = null;
      try {
        await handler({ task, signal: controller.signal, logger: this.logger });
      } catch (err) {
        status = 'failed';
        // Prefer the abort reason (lock lost / shutdown) over a generic AbortError.
        const cause = controller.signal.aborted ? controller.signal.reason : err;
        error = cause?.message ?? String(cause);
      }
      // Even if the handler finished, exclusivity was not guaranteed for the
      // whole run once the lock was lost, so record that explicitly.
      if (heartbeat.lost) {
        status = 'lock_lost';
        error = error ?? new LockLostError(lockName).message;
      }
      await this.repo.finishRun(runId, status, error);
      if (status !== 'succeeded') this.logger.warn(`task "${task.name}" run ${runId}: ${status}: ${error}`);
      return { outcome: status, runId, error };
    } finally {
      heartbeat.stop();
      this.controllers.delete(controller);
      // Compare-and-delete: if the lock already expired and someone else took
      // it, this is a no-op instead of deleting their lock.
      await this.lock.release(lockName, token).catch((err) => {
        this.logger.warn(`failed to release ${lockName} (it will expire on its own):`, err.message);
      });
    }
  }

  /**
   * Renew the lock every ttl/3 while the handler runs. If renewal reports
   * that we no longer own the key, or Redis has been unreachable for a full
   * TTL, the lock must be assumed lost and the handler is aborted.
   */
  #startHeartbeat(lockName, token, controller) {
    const state = { lost: false, stop: () => clearInterval(timer) };
    let lastConfirmedAt = Date.now();

    const markLost = () => {
      if (state.lost) return;
      state.lost = true;
      clearInterval(timer);
      controller.abort(new LockLostError(lockName));
    };

    const timer = setInterval(async () => {
      try {
        if (await this.lock.extend(lockName, token, this.lockTtlMs)) {
          lastConfirmedAt = Date.now();
        } else {
          markLost();
        }
      } catch (err) {
        this.logger.warn(`could not extend ${lockName}:`, err.message);
        if (Date.now() - lastConfirmedAt >= this.lockTtlMs) markLost();
      }
    }, Math.max(1, Math.floor(this.lockTtlMs / 3)));

    return state;
  }

  /** Current lock holder (from Redis) and last run (from Postgres) per task. */
  async status() {
    const tasks = await this.repo.listWithLastRun();
    return Promise.all(
      tasks.map(async (task) => {
        const token = await this.lock.holder(`task:${task.id}`);
        return { ...task, lockedBy: token ? token.slice(0, token.lastIndexOf(':')) : null };
      }),
    );
  }

  /**
   * Stop scheduling new ticks, give running handlers `timeoutMs` to finish,
   * then abort them. Locks are released by the runs themselves.
   */
  async stop({ timeoutMs = 10_000 } = {}) {
    this.stopping = true;
    for (const job of this.jobs) job.stop();
    this.jobs = [];

    if (await settlesWithin([...this.inFlight], timeoutMs)) return;

    this.logger.warn(`aborting ${this.controllers.size} task run(s) still in progress`);
    for (const controller of this.controllers) controller.abort(new ShutdownError());
    await settlesWithin([...this.inFlight], 1_000);
  }
}

async function settlesWithin(promises, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  const settled = Promise.allSettled(promises).then(() => true);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { Scheduler, LockLostError, ShutdownError };
