const { DataTypes, Model } = require('sequelize');
const sequelize = require('../database/database').sequelize;

class TaskHistory extends Model { }

TaskHistory.init(
    {
        taskId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        serverId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        startTime: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        endTime: {
            type: DataTypes.DATE,
        },
    },
    {
        sequelize,
        modelName: 'TaskHistory',
    }
);

module.exports = TaskHistory;