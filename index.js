const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('baileys-elite');
const pino = require('pino');
const config = require('./settings');
const { initMongo, saveCredsToMongo, loadCredsFromMongo, removeSessionFromMongo, addNumberToMongo } = require('./lib/database');
const { activeSockets } = require('./lib/sessionStore');

const app = express();
const PORT = process.env.PORT || 8000;

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'fruntend')));

// ========== FILE UPLOAD (Memory) ==========
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// ========== TEMPORARY DP STORE ==========
// This map holds the uploaded DP buffer temporarily until the user pairs.
const pendingDpMap = new Map(); // key: number (sanitized), value: { buffer, mime }

// ========== MONGO INIT ==========
initMongo().catch(console.error);

// ========== CORE PAIRING ENGINE ==========
async function EmpirePair(number, res, dpBuffer, dpMime) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);

    // Ensure session directory exists
    fs.ensureDirSync(sessionPath);

    // Preload creds from Mongo if they exist
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
            browser: ["NIMA-DEV", "Chrome", "120.0.0.0"]
        });

        // Save creds to Mongo on update
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

        // Handle Connection Open (SET DP HERE!)
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                try {
                    const userJid = socket.user.id; // e.g., 9470xxxx@s.whatsapp.net
                    
                    // Check if there is a pending DP for this number
                    const pendingData = pendingDpMap.get(sanitizedNumber);
                    if (pendingData) {
                        console.log(`🖼️ Setting DP for ${sanitizedNumber}...`);
                        // Update Profile Picture
                        await socket.updateProfilePicture(userJid, pendingData.buffer);
                        console.log(`✅ DP Set successfully for ${sanitizedNumber}`);
                        
                        // Send a confirmation message to the user
                        await socket.sendMessage(userJid, { text: `✅ *${config.BOT_NAME}* විසින් ඔබගේ ගිණුමේ DP එක සාර්ථකව Update කරන ලදී.` });
                        
                        // Clear the pending DP to save memory
                        pendingDpMap.delete(sanitizedNumber);
                    } else {
                        console.log(`ℹ️ No pending DP for ${sanitizedNumber}. Using default.`);
                    }

                    // Add to active list
                    activeSockets.set(sanitizedNumber, socket);
                    await addNumberToMongo(sanitizedNumber);

                } catch (err) {
                    console.error('Error in connection.open handler:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === 401 || lastDisconnect?.error?.message?.includes('logged out');
                if (isLoggedOut) {
                    console.log(`User ${sanitizedNumber} logged out. Cleaning up.`);
                    try {
                        activeSockets.delete(sanitizedNumber);
                        await removeSessionFromMongo(sanitizedNumber);
                        fs.removeSync(sessionPath);
                    } catch(e) {}
                } else {
                    // Auto Reconnect attempt for other errors
                    console.log(`Connection closed for ${sanitizedNumber}. Reconnecting...`);
                    setTimeout(() => {
                        if (!activeSockets.has(sanitizedNumber)) {
                            EmpirePair(number, res, dpBuffer, dpMime).catch(console.error);
                        }
                    }, 10000);
                }
            }
        });

        // Request Pairing Code
        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES || 5;
            let code;
            while (retries > 0) {
                try {
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            if (!res.headersSent) {
                // Send the code back to the web UI
                return res.status(200).send({ status: 'success', code: code, message: 'Pairing code generated. Use it in WhatsApp.' });
            }
        } else {
            if (!res.headersSent) return res.status(400).send({ status: 'failed', message: 'Already registered/paired.' });
        }

    } catch (error) {
        console.error('EmpirePair Error:', error);
        if (!res.headersSent) res.status(503).send({ status: 'error', message: 'Service Unavailable' });
    }
}

// ========== ROUTES ==========

// Serve Main Web Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'fruntend', 'index.html'));
});

// API: Upload DP + Request Pair Code
app.post('/pair', upload.single('dpImage'), async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).send({ status: 'error', message: 'Phone number is required.' });

        const sanitized = number.replace(/[^0-9]/g, '');
        if (sanitized.length < 10) return res.status(400).send({ status: 'error', message: 'Invalid phone number.' });

        // Check if already connected
        if (activeSockets.has(sanitized)) {
            return res.status(400).send({ status: 'error', message: 'This number is already connected and active.' });
        }

        // Handle DP Upload
        let dpBuffer = null;
        let dpMime = 'image/jpeg';
        if (req.file) {
            dpBuffer = req.file.buffer;
            dpMime = req.file.mimetype;
        } else {
            // If no image uploaded, use a default one (optional)
            // For this requirement, we force upload. But if you want default, uncomment below.
            // const defaultBuf = await getBuffer(config.IMAGE_PATH);
            // if (defaultBuf) dpBuffer = defaultBuf;
            // dpMime = 'image/jpeg';
            // Since user explicitly wants upload, let's reject if no image.
            return res.status(400).send({ status: 'error', message: 'Please upload a profile picture (DP) first.' });
        }

        // Store the DP in the pending map
        pendingDpMap.set(sanitized, { buffer: dpBuffer, mime: dpMime });

        // Initiate Pairing
        // Note: EmpirePair will send the response (code) back to the client.
        await EmpirePair(sanitized, res, dpBuffer, dpMime);

    } catch (error) {
        console.error('Pair Route Error:', error);
        if (!res.headersSent) res.status(500).send({ status: 'error', message: 'Internal Server Error' });
    }
});

// API: Get Active Sessions (Optional)
app.get('/active', (req, res) => {
    res.status(200).send({ 
        status: 'success', 
        activeCount: activeSockets.size, 
        numbers: Array.from(activeSockets.keys()) 
    });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════╗
║  🚀 NIMA DEV FULL DP IS RUNNING  ║
║  📡 PORT: http://localhost:${PORT}   ║
╚═══════════════════════════════════╝
    `);
});

// Cleanup on exit
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws?.close(); } catch(e) {}
        activeSockets.delete(number);
        try { fs.removeSync(path.join(os.tmpdir(), `session_${number}`)); } catch(e) {}
    });
});
