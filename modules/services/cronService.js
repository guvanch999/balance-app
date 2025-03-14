const cron = require('cron').CronJob;
const Task = require('../../models/task');
const TaskHistory = require('../../models/taskHistory');
const redisClient = require('../../utils/redisClient');
require('dotenv').config();

const serverId = process.env.SERVER_ID;

const tasks = {};

async function startCronJobs() {
    // Получаем все задачи из базы данных
    const allTasks = await Task.findAll();
    // Создаем cron job для каждой задачи
    for (const task of allTasks) {
        if (await tryLockTask(task.id)) {
            const taskHistory = await runTask(task);
            tasks[task.id] = new cron(task.interval, async () => {
                try {
                    await processTask(task);
                } catch (error) {
                    console.error(`Ошибка при выполнении задачи ${task.name}:`, error);
                }
            }, async () => {
                await unlockTask(task.id)
                await endTask(taskHistory);
            }, true);
            console.log(`Задача ${task.name} запущена на сервере ${serverId}`);
        }
    }

    console.log(`Сервер ${serverId} запустил cron задачи`);
}

async function runTask(task) {
    await Task.update({ status: 'running' }, { where: { id: task.id } });
    const startTime = new Date();
    return await TaskHistory.create({
        taskId: task.id,
        serverId: serverId,
        startTime: startTime,
    });
}

async function endTask(taskHistory) {
    await Task.update({ status: 'error' }, { where: { id: task.id } });
    const endTime = new Date();
    await TaskHistory.update(
        { endTime: endTime },
        { where: { id: taskHistory.id } }
    );
}

async function processTask(task) {
    console.log(`Задача ${task.name} выполняется на сервере ${serverId}`);
    await new Promise((resolve) => setTimeout(resolve, 120000));
}

async function tryLockTask(taskId) {
    let task = await redisClient.get(`task_lock:${taskId}`);
    if (task) {
        return false;
    }
    const lock = await redisClient.set(`task_lock:${taskId}`, serverId);
    return lock === 'OK';
}

async function unlockTask(taskId) {
    await redisClient.del(`task_lock:${taskId}`);
}

async function getTasksStatus() {
    const allTasks = await Task.findAll();
    const tasksStatus = [];

    for (const task of allTasks) {
        const lock = await redisClient.get(`task_lock:${task.id}`);
        const history = await TaskHistory.findOne({
            where: { taskId: task.id, endTime: null },
            order: [['startTime', 'DESC']],
        });

        tasksStatus.push({
            name: task.name,
            serverId: lock || (history ? history.serverId : null),
            runningSince: history ? history.startTime : null,
        });
    }
    return tasksStatus;
}

module.exports = {
    startCronJobs,
    getTasksStatus,
};