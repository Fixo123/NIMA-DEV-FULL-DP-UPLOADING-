const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('./settings');
const { initMongo, saveCredsToMongo, loadCredsFromMongo, removeSessionFromMongo, addNumberToMongo } = require('./lib/database');
const { activeSockets } = require('./lib/sessionStore');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'fruntend')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const pendingDpMap = new Map();

initMongo().catch(console.error);

// ========== CORE PAIRING ENGINE ==========
async function EmpirePair(number, res, dpBuffer, dpMime) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);

    fs.ensureDirSync(sessionPath);

    try {
        const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
        if (mongoDoc?.creds) {
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
        }
    } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });

    try {
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger,
            browser: ["NIMA-DEV", "Chrome", "120.0.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsPath = path.join(sessionPath, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    await saveCredsToMongo(sanitizedNumber, credsData);
                }
            } catch (e) { console.error('Creds save error:', e); }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                try {
                    console.log(`✅ Connection OPEN for ${sanitizedNumber}`);
                    const userJid = socket.user.id;
                    
                    const pendingData = pendingDpMap.get(sanitizedNumber);
                    if (pendingData) {
                        console.log(`🖼️ Setting DP for ${sanitizedNumber}...`);
                        try {
                            await socket.updateProfilePicture(userJid, pendingData.buffer);
                            console.log(`✅ DP Set successfully`);
                            await socket.sendMessage(userJid, { text: `✅ *${config.BOT_NAME}* විසින් ඔබගේ ගිණුමේ DP එක සාර්ථකව Update කරන ලදී.` });
                        } catch (dpErr) {
                            console.error('DP Set Error:', dpErr);
                        }
                        pendingDpMap.delete(sanitizedNumber);
                    }

                    activeSockets.set(sanitizedNumber, socket);
                    await addNumberToMongo(sanitizedNumber);
                    console.log(`✅ ${sanitizedNumber} added to active sessions`);

                } catch (err) {
                    console.error('Error in connection.open handler:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === 401 || lastDisconnect?.error?.message?.includes('logged out');
                
                if (isLoggedOut) {
                    try {
                        activeSockets.delete(sanitizedNumber);
                        await removeSessionFromMongo(sanitizedNumber);
                        fs.removeSync(sessionPath);
                    } catch(e) {}
                } else {
                    console.log(`🔄 Reconnecting ${sanitizedNumber} in 10s...`);
                    setTimeout(() => {
                        if (!activeSockets.has(sanitizedNumber)) {
                            EmpirePair(number, res, dpBuffer, dpMime).catch(console.error);
                        }
                    }, 10000);
                }
            }
        });

        // ===== PAIRING CODE - FIXED =====
        if (!socket.authState.creds.registered) {
            console.log(`🔑 Requesting pairing code for ${sanitizedNumber}...`);
            
            let code = null;
            let retries = 5;
            
            while (retries > 0 && !code) {
                try {
                    // 🔥 FIX: Use the correct method
                    code = await socket.requestPairingCode(sanitizedNumber);
                    console.log(`✅ Pairing code generated: ${code}`);
                    break;
                } catch (error) {
                    console.error(`❌ Attempt failed (${retries} left):`, error.message);
                    retries--;
                    if (retries > 0) await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            if (code && !res.headersSent) {
                // Format code properly
                let formattedCode = code;
                if (code.length >= 12) {
                    formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                } else if (code.length >= 8) {
                    formattedCode = code.match(/.{1,4}/g)?.join(' ') || code;
                }
                
                return res.status(200).send({
                    status: 'success',
                    code: formattedCode,
                    rawCode: code,
                    message: 'Pairing code generated. Go to WhatsApp Web > Link with phone number.'
                });
            } else if (!res.headersSent) {
                return res.status(500).send({
                    status: 'error',
                    message: 'Failed to generate pairing code after retries.'
                });
            }
        } else {
            console.log(`ℹ️ ${sanitizedNumber} already registered`);
            if (!res.headersSent) {
                return res.status(400).send({
                    status: 'failed',
                    message: 'Already registered/paired.'
                });
            }
        }

    } catch (error) {
        console.error('❌ EmpirePair Error:', error);
        if (!res.headersSent) {
            res.status(503).send({
                status: 'error',
                message: 'Service Unavailable: ' + error.message
            });
        }
    }
}

// ========== ROUTES ==========

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'fruntend', 'index.html'));
});

app.post('/pair', upload.single('dpImage'), async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).send({ status: 'error', message: 'Phone number is required.' });

        const sanitized = number.replace(/[^0-9]/g, '');
        if (sanitized.length < 10) return res.status(400).send({ status: 'error', message: 'Invalid phone number.' });

        if (activeSockets.has(sanitized)) {
            return res.status(400).send({ status: 'error', message: 'This number is already connected and active.' });
        }

        let dpBuffer = null;
        if (req.file) {
            dpBuffer = req.file.buffer;
        } else {
            return res.status(400).send({ status: 'error', message: 'Please upload a profile picture (DP) first.' });
        }

        pendingDpMap.set(sanitized, { buffer: dpBuffer });

        await EmpirePair(sanitized, res, dpBuffer);

    } catch (error) {
        console.error('Pair Route Error:', error);
        if (!res.headersSent) res.status(500).send({ status: 'error', message: 'Internal Server Error' });
    }
});

app.get('/pair-status', async (req, res) => {
    try {
        const { number } = req.query;
        if (!number) return res.status(400).send({ status: 'error', message: 'Number required' });

        const sanitized = number.replace(/[^0-9]/g, '');
        const isConnected = activeSockets.has(sanitized);

        res.status(200).send({
            status: 'success',
            connected: isConnected,
            number: sanitized
        });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).send({ status: 'error', message: 'Failed to check status' });
    }
});

app.get('/active', (req, res) => {
    res.status(200).send({
        status: 'success',
        activeCount: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║  🚀 NIMA DEV FULL DP IS RUNNING               ║
║  📡 PORT: http://localhost:${PORT}                ║
║  🔑 PAIR CODE ONLY (100% WORKING)             ║
╚════════════════════════════════════════════════╝
    `);
});

process.on('exit', () => {
    activeSockets.forEach((socket) => {
        try { socket.ws?.close(); } catch(e) {}
    });
});
