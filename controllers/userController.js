const userService = require('../services/userService');
const userValidator = require('../validators/userValidator');

async function updateBalance(req, res, next) {
    try {
        const {userId, amount} = req.body;
        await userValidator.validateUpdateBalance(req.body);
        const updatedUser = await userService.updateBalance(userId, amount);
        res.json(updatedUser);

    } catch (error) {
        next(error);
    }
}

module.exports = {
    updateBalance,
};