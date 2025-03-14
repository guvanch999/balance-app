const Joi = require('joi');

const balanceValidator = Joi.object({
    userId: Joi.number().integer().required(),
    amount: Joi.number().integer().required(),
});

module.exports = {
    balanceValidator,
};