const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

module.exports = {
    MONGO_URI: process.env.MONGO_URI || 'mongodb+srv://nima:nima@nimabot.gkpbhvh.mongodb.net/',
    MONGO_DB: process.env.MONGO_DB || 'nima_dev_db',
    PREFIX: process.env.PREFIX || '.',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '94760743488',
    BOT_NAME: process.env.BOT_NAME || 'NIMA DEV FULL DP',
    IMAGE_PATH: process.env.IMAGE_PATH || 'https://files.catbox.moe/kieruf.png', // default dp
    MAX_RETRIES: 5
};
