const { DataTypes, Model } = require('sequelize');
const sequelize = require('../database/database').sequelize;

class User extends Model { }

User.init(
    {
        balance: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        modelName: 'User',
    }
);

module.exports = User;