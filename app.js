const express = require('express');
const {umzug, sequelize} = require('./utils/helpers');
const userRoutes = require('./routes/users');
const errorHandler = require('./middlewares/errorHandler');

const app = express();
const port = 3000;

app.use(express.json());
app.use('/users', userRoutes);
app.use(errorHandler);

async function start() {
    try {
        await sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        await umzug.up();
        console.log('Migrations have been executed successfully.');

        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });
    } catch (error) {
        console.error('Unable to start the application:', error);
    }
}

start();