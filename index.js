import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createWASocket = typeof makeWASocket === 'function' ? makeWASocket : (makeWASocket.default || makeWASocket);

const app = express();
app.use(express.json());

// Enable CORS for frontend / admin panel AJAX calls
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected'; // disconnected, initializing, qr_ready, connected
let connectedPhone = null;

async function startSock() {
    try {
        if (sock) {
            try { sock.end(undefined); } catch (e) {}
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = createWASocket({
            auth: state,
            printQRInTerminal: false, // Do not print ASCII in terminal
            logger: pino({ level: 'silent' }),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                connectionStatus = 'qr_ready';
                console.log('\n[WA-BOT] ====================================================');
                console.log('[WA-BOT] QR Code Siap! Silakan scan melalui WhatsApp HP Anda');
                console.log('[WA-BOT] (Buka WA > Titik 3 / Setelan > Perangkat Tertaut):');
                console.log('[WA-BOT] ====================================================');
                try {
                    qrcodeTerminal.generate(qr, { small: true });
                } catch (e) {}
                console.log('[WA-BOT] Atau scan di browser: Panel Admin > Pengaturan Toko\n');
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const errorStr = (error?.message || '') + ' ' + (error?.toString() || '');
                const isBadSession = statusCode === DisconnectReason.loggedOut || statusCode === 401 || errorStr.includes('Bad MAC');
                
                console.log('[WA-BOT] Koneksi ditutup. Status code:', statusCode, 'Detail:', error?.message || 'Disconnected');
                
                connectionStatus = 'disconnected';
                connectedPhone = null;
                currentQR = null;
                sock = null;

                if (isBadSession) {
                    console.log('[WA-BOT] Sesi lama tidak valid / Bad MAC. Menghapus data sesi lama...');
                    try {
                        if (fs.existsSync(AUTH_DIR)) {
                            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                            fs.mkdirSync(AUTH_DIR, { recursive: true });
                        }
                    } catch (e) {}
                    console.log('[WA-BOT] Memulai ulang socket untuk membuat QR Code baru...\n');
                    setTimeout(() => startSock(), 1500);
                } else {
                    const credsFileExists = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
                    if (credsFileExists) {
                        setTimeout(() => startSock(), 3000);
                    }
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQR = null;
                const jid = sock?.user?.id || '';
                connectedPhone = jid.split(':')[0] || jid.split('@')[0];
                console.log(`\n[WA-BOT] ====================================================`);
                console.log(`[WA-BOT] WhatsApp Berhasil Terhubung! Nomor Aktif: +${connectedPhone}`);
                console.log(`[WA-BOT] Bot siap mengirim notifikasi pesanan & resi otomatis.`);
                console.log(`[WA-BOT] ====================================================\n`);
            }
        });
    } catch (err) {
        console.error('[WA-BOT] Error starting Baileys socket:', err);
        connectionStatus = 'disconnected';
    }
}

// On startup: Start socket to either reconnect existing session or generate QR code
console.log(`[WA-BOT] WhatsApp Service aktif pada port ${PORT}. Menyiapkan koneksi...`);
startSock();

// Endpoint 1: Basic status
app.get('/status', (req, res) => {
    res.json({
        online: true,
        status: connectionStatus,
        phone: connectedPhone,
        hasQr: !!currentQR,
    });
});

// Endpoint 2: Extended status with QR image DataURL for Admin Panel embed
app.get('/qr-data', async (req, res) => {
    let qrImage = null;
    if (currentQR && connectionStatus !== 'connected') {
        try {
            qrImage = await qrcode.toDataURL(currentQR, { width: 280, margin: 1 });
        } catch (e) {
            console.error('Error generating QR data URL:', e);
        }
    }

    res.json({
        online: true,
        status: connectionStatus,
        phone: connectedPhone,
        hasQr: !!currentQR,
        qrImage: qrImage,
    });
});

// Endpoint 3: Connect / Start session on demand (Triggered from Admin Panel)
app.post('/connect', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ success: true, status: 'connected', phone: connectedPhone });
    }

    if (connectionStatus === 'qr_ready' && currentQR) {
        return res.json({ success: true, status: 'qr_ready', hasQr: true });
    }

    console.log('[WA-BOT] Memulai sesi scan QR WhatsApp atas permintaan Admin...');
    connectionStatus = 'initializing';
    currentQR = null;
    startSock();
    return res.json({ success: true, status: 'initializing', message: 'Memulai sesi WhatsApp...' });
});

// Endpoint 4: Disconnect & Clear session (Logout & Putuskan Sesi)
app.post('/disconnect', async (req, res) => {
    try {
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                try { sock.end(undefined); } catch (e2) {}
            }
            sock = null;
        }

        connectionStatus = 'disconnected';
        currentQR = null;
        connectedPhone = null;

        // Clear auth directory
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        console.log('[WA-BOT] Sesi WhatsApp telah diputuskan oleh Admin dan kredensial dihapus.');
        return res.json({ success: true, status: 'disconnected', message: 'Sesi WhatsApp berhasil diputuskan.' });
    } catch (err) {
        console.error('[WA-BOT] Gagal memutuskan sesi:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint 5: Web QR Scanner page (standalone backup)
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>WhatsApp Terhubung</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body style="font-family:sans-serif; background:#0a0a0a; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
                <div style="background:#171717; padding:40px; border-radius:24px; border:1px solid #262626; text-align:center;">
                    <div style="width:60px; height:60px; background:#22c55e; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 16px;">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                    <h2 style="margin:0 0 8px;">WhatsApp Berhasil Terhubung!</h2>
                    <p style="color:#a3a3a3; font-size:14px; margin:0;">Nomor Aktif: +${connectedPhone}</p>
                    <p style="color:#737373; font-size:12px; margin-top:16px;">Bot siap mengirimkan notifikasi otomatis.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (!currentQR) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Memuat QR WhatsApp</title><meta http-equiv="refresh" content="3"></head>
            <body style="font-family:sans-serif; background:#0a0a0a; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
                <div style="background:#171717; padding:30px; border-radius:20px; border:1px solid #262626; text-align:center;">
                    <h3>Sesi Belum Aktif atau Sedang Menyiapkan QR...</h3>
                    <p style="color:#a3a3a3; font-size:13px;">Buka Panel Pengaturan Admin untuk memulai atau klik tombol di bawah:</p>
                    <button onclick="fetch('/connect', {method:'POST'}).then(()=>location.reload())" style="padding:10px 20px; background:#22c55e; color:#fff; border:none; border-radius:10px; font-weight:bold; cursor:pointer; margin-top:10px;">Mulai Sesi / Generate QR</button>
                </div>
            </body>
            </html>
        `);
    }

    try {
        const qrImage = await qrcode.toDataURL(currentQR, { width: 320 });
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Scan QR WhatsApp Bot — Bengkel Las Jasa Teknik</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="refresh" content="15">
            </head>
            <body style="font-family:sans-serif; background:#0a0a0a; color:#fff; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px;">
                <div style="background:#171717; padding:32px; border-radius:24px; border:1px solid #262626; text-align:center; max-width:420px; box-shadow:0 20px 40px rgba(0,0,0,0.5);">
                    <h2 style="margin:0 0 8px; font-size:20px;">Scan QR WhatsApp Bot</h2>
                    <p style="color:#a3a3a3; font-size:12px; margin:0 0 20px; line-height:1.5;">Buka WhatsApp di HP Anda &rarr; Perangkat Tertaut &rarr; Tautkan Perangkat</p>
                    <div style="background:#fff; padding:16px; border-radius:16px; display:inline-block;">
                        <img src="${qrImage}" alt="Scan QR" style="display:block; width:260px; height:260px;" />
                    </div>
                    <p style="color:#737373; font-size:11px; margin-top:20px;">Halaman me-refresh otomatis setiap 15 detik jika QR kedaluwarsa.</p>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR Code');
    }
});

// Endpoint 6: Send text message
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ success: false, error: 'Parameter number dan message wajib diisi.' });
    }

    if (connectionStatus !== 'connected' || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp bot belum terhubung.' });
    }

    try {
        const formattedNumber = `${number}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        console.log(`[WA-BOT] Pesan berhasil dikirim ke: ${number}`);
        return res.json({ success: true, target: number });
    } catch (error) {
        console.error('[WA-BOT] Gagal mengirim pesan:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[WA-BOT] WhatsApp Service aktif pada http://localhost:${PORT}`);
});
