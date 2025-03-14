const redis = require('redis');
const config = require('../config/redis');
const redisClient = redis.createClient({
    url: config.development.url
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

redisClient.connect();

module.exports = redisClient;