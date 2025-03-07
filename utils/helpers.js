const Sequelize = require('sequelize');
const {Umzug, SequelizeStorage} = require('umzug');
const config = require('../config/database').development;

const sequelize = new Sequelize(config.database, config.username, config.password, {
    host: config.host,
    dialect: config.dialect,
    logging: false
});


const umzug = new Umzug({
    migrations: {
        glob: 'migrations/*.js',
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({sequelize}),
    logger: console,
});

module.exports = {
    sequelize,
    umzug,
};