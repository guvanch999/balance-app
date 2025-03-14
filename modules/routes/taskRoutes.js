const express = require('express');
const taskController = require('../controllers/taskController');

const router = express.Router();

router.get('/status', taskController.getTasksStatus);

module.exports = router;