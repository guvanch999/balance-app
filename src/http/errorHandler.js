'use strict';

const { AppError } = require('../errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

/**
 * Turns errors into JSON responses. Known errors (AppError) keep their status
 * and message; anything else becomes a 500 with a generic message so internal
 * details (SQL, stack traces) never reach the client.
 */
function errorHandler({ logger = console } = {}) {
  // Express recognises error middleware by its four-argument signature,
  // so `next` must stay in the parameter list even though it is unused.
  return (err, req, res, next) => {
    if (err instanceof AppError) {
      const body = { code: err.code, message: err.message };
      if (err.details !== undefined) body.details = err.details;
      return res.status(err.status).json({ error: body });
    }

    // Malformed JSON body, payload too large, etc. raised by express.json().
    if (err.type && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }

    logger.error(`unhandled error on ${req.method} ${req.originalUrl}:`, err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
}

module.exports = { errorHandler, notFoundHandler };
