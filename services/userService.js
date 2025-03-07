const User = require('../models/user');
const {Sequelize} = require('sequelize')

async function updateBalance(userId, amount) {
    const [updatedRows, updatedUsers] = await User.update(
        { balance: Sequelize.literal(`balance + ${amount}`) },
        {
            where: { id: userId, balance: { [Sequelize.Op.gte]: -amount } },
            returning: true
        }
    );

    if (updatedRows === 0) {
        throw new Error('Недостаточно средств');
    }

    return updatedUsers[0];
}

module.exports = {
    updateBalance,
};