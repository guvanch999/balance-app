'use strict';

const os = require('node:os');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Reads configuration from the environment. Called once at startup so a
 * misconfigured instance fails fast instead of half-starting.
 */
function loadConfig() {
  return {
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    serverId: process.env.SERVER_ID || os.hostname(),
    scheduler: {
      enabled: bool('SCHEDULER_ENABLED', true),
      lockTtlMs: int('LOCK_TTL_MS', 30_000),
    },
    seedDemoData: bool('SEED_DEMO_DATA', false),
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10_000),
  };
}

module.exports = { loadConfig };
