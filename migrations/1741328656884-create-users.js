'use strict';

const {Sequelize} = require('sequelize')

module.exports = {
    up: async ({context: queryInterface}) => { // Возвращаем Sequelize
        await queryInterface.createTable('Users', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER, // Используем Sequelize.INTEGER
            },
            balance: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE, // Используем Sequelize.DATE
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE, // Используем Sequelize.DATE
            },
        });

        await queryInterface.bulkInsert('Users', [
            {
                balance: 10000,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ]);
    },

    down: async ({context: queryInterface}) => { // Возвращаем Sequelize
        await queryInterface.dropTable('Users');
    },
};