const express = require('express');
const userController = require('../controllers/userController');

const router = express.Router();

router.post('/balance/update', userController.updateBalance);

module.exports = router;