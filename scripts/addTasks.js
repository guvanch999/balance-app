// Пример скрипта для заполнения задач
const Task = require('../models/task');
const { sequelize } = require('../database/database');

async function createTasks() {
    try {
        await sequelize.authenticate();
        await Task.bulkCreate([
            { name: 'Task 1', interval: '*/5 * * * * *', handler: 'handler1', status: 'active' }, // Каждые 5 секунд
            { name: 'Task 2', interval: '*/10 * * * * *', handler: 'handler2', status: 'active' }, // Каждые 10 секунд
            { name: 'Task 3', interval: '*/15 * * * * *', handler: 'handler3', status: 'active' }, // Каждые 15 секунд
            { name: 'Task 4', interval: '*/20 * * * * *', handler: 'handler4', status: 'active' }, // Каждые 20 секунд
            { name: 'Task 5', interval: '*/25 * * * * *', handler: 'handler5', status: 'active' }, // Каждые 25 секунд
            { name: 'Task 6', interval: '*/30 * * * * *', handler: 'handler6', status: 'active' }, // Каждые 30 секунд
            { name: 'Task 7', interval: '*/35 * * * * *', handler: 'handler7', status: 'active' }, // Каждые 35 секунд
            { name: 'Task 8', interval: '*/40 * * * * *', handler: 'handler8', status: 'active' }, // Каждые 40 секунд
            { name: 'Task 9', interval: '*/45 * * * * *', handler: 'handler9', status: 'active' }, // Каждые 45 секунд
            { name: 'Task 10', interval: '*/50 * * * * *', handler: 'handler10', status: 'active' }, // Каждые 50 секунд
        ]);
        console.log('Tasks created successfully.');
    } catch (error) {
        console.error('Error creating tasks:', error);
    } finally {
        sequelize.close();
    }
}

createTasks();