const taskService = require('../services/cronService');

async function getTasksStatus(req, res, next) {
    try {
        const tasksStatus = await taskService.getTasksStatus();
        res.json(tasksStatus);
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getTasksStatus,
};