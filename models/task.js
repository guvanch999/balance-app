const { DataTypes, Model } = require('sequelize');
const sequelize = require('../database/database').sequelize;

class Task extends Model { }

Task.init(
    {
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        interval: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        handler: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        status: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        modelName: 'Task',
    }
);

module.exports = Task;