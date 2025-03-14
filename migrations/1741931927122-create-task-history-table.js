'use strict';

const { Sequelize } = require('sequelize')

module.exports = {
    up: async ({ context: queryInterface }) => {
        await queryInterface.createTable('TaskHistories', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            taskId: {
                type: Sequelize.INTEGER,
                allowNull: false,
            },
            serverId: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            startTime: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            endTime: {
                type: Sequelize.DATE,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
        });
    },

    down: async ({ context: queryInterface }) => {
        await queryInterface.dropTable('TaskHistories');
    },
};