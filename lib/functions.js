const axios = require('axios');

const getBuffer = async (url) => {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer' });
        return res.data;
    } catch (e) {
        return null;
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const runtime = (seconds) => {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
};

module.exports = { getBuffer, sleep, runtime };
