const User = require('../../models/user');
const { Sequelize } = require('sequelize')

async function increaseBalance(userId, amount) {
    const [updatedRows, updatedUsers] = await User.update(
        { balance: Sequelize.literal(`balance + ${amount}`) },
        {
            where: { id: userId },
            returning: true
        }
    );

    if (updatedRows === 0) {
        throw new Error('Пользователь не найден');
    }

    return updatedUsers[0];
}

async function decreaseBalance(userId, amount) {
    const [updatedRows, updatedUsers] = await User.update(
        { balance: Sequelize.literal(`balance - ${amount}`) },
        {
            where: { id: userId, balance: { [Sequelize.Op.gte]: amount } },
            returning: true
        }
    );

    if (updatedRows === 0) {
        throw new Error('Недостаточно средств');
    }

    return updatedUsers[0];
}

module.exports = {
    increaseBalance,
    decreaseBalance,
};