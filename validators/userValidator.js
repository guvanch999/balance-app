const Joi = require('joi');

async function validateUpdateBalance(data) {
    const schema = Joi.object({
        userId: Joi.number().integer().required(),
        amount: Joi.number().integer().required(),
    });
    await schema.validateAsync(data);
}

module.exports = {
    validateUpdateBalance,
};