'use strict';

const express = require('express');
const { ValidationError } = require('../errors');

// Express 5 forwards rejected promises from async handlers to the error
// middleware, so handlers below do not need try/catch.
function balanceRoutes(balanceService) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    res.status(201).json(await balanceService.createUser());
  });

  router.get('/:userId', async (req, res) => {
    res.json(await balanceService.getUser(req.params.userId));
  });

  router.post('/:userId/deposit', async (req, res) => {
    res.json(await balanceService.deposit(req.params.userId, req.body?.amount));
  });

  router.post('/:userId/withdraw', async (req, res) => {
    res.json(await balanceService.withdraw(req.params.userId, req.body?.amount));
  });

  return router;
}

/**
 * The endpoint from the original assignment: a signed `amount` in one route.
 * Kept for compatibility; positive deposits, negative withdraws.
 */
function legacyBalanceRoute(balanceService) {
  return async (req, res) => {
    const { userId, amount } = req.body ?? {};
    if (typeof amount !== 'number' || amount === 0) {
      throw new ValidationError('amount must be a non-zero integer', { field: 'amount' });
    }
    const user =
      amount > 0
        ? await balanceService.deposit(userId, amount)
        : await balanceService.withdraw(userId, -amount);
    res.json(user);
  };
}

module.exports = { balanceRoutes, legacyBalanceRoute };
