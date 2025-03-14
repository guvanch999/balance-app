const express = require('express');
const { umzug, sequelize } = require('./database/database');
const userRoutes = require('./modules/routes/users');
const errorHandler = require('./middlewares/errorHandler');
const cronService = require('./modules/services/cronService');
const taskRoutes = require('./modules/routes/taskRoutes');
const config = require('./config/server');
const app = express();
const port = config.port;

app.use(express.json());
app.use('/users', userRoutes);
app.use('/tasks', taskRoutes);
app.use(errorHandler);

async function start() {
    try {
        await sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        await umzug.up();
        console.log('Migrations have been executed successfully.');

        await cronService.startCronJobs();
        console.log('Cron jobs started.');

        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });
    } catch (error) {
        console.error('Unable to start the application:', error);
    }
}

start();