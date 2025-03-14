const userService = require('../services/userService');
const userValidator = require('../../validators/userValidator');

async function updateBalance(req, res, next) {
    try {
        const { error } = userValidator.balanceValidator.validate(req.body);
        if (error) {
            return res.status(400).json({ message: error.details });
        }
        const { userId, amount } = req.body;
        let updatedUser;
        if (amount > 0) {
            updatedUser = await userService.increaseBalance(userId, amount);
        } else {
            updatedUser = await userService.decreaseBalance(userId, amount);
        }
        res.json(updatedUser);

    } catch (error) {
        next(error);
    }
}

module.exports = {
    updateBalance,
};