'use strict';

/** An error that is safe to show to API clients, with an HTTP status and a stable code. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

class InsufficientFundsError extends AppError {
  constructor(userId, amount) {
    super(409, 'INSUFFICIENT_FUNDS', `User ${userId} does not have ${amount} available`);
    this.name = 'InsufficientFundsError';
  }
}

module.exports = { AppError, ValidationError, NotFoundError, InsufficientFundsError };
