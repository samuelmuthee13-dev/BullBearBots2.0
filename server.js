/* ═══════════════════════════════════════════════════════════════
   SERVER.JS  —  BULL BEAR Backend
   Pure WebSocket server (no HTTP framework needed)
   Hosts bot engines, communicates with APK UI in real time
   Greenlight page: visit the server URL in a browser to confirm
   everything is running
═══════════════════════════════════════════════════════════════ */

'use strict';
require('dotenv').config();

const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const bots    = require('./bots5-backend.js');

const PORT    = process.env.PORT || 10000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

/* ── Tracking connected APK clients ─────────────────────────── */
const clients = new Set();

/* ── HTTP server — serves the Greenlight page ───────────────── */
const httpServer = http.createServer((req, res) => {
  const uptime  = formatUptime(process.uptime());
  const botCount = Object.keys(bots.activeBotInstances).length;
  const clientCount = clients.size;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>BULL BEAR — Server Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: #00ff88;
      font-family: 'Courier New', monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      flex-direction: column;
      gap: 24px;
    }
    .dot {
      width: 80px; height: 80px;
      border-radius: 50%;
      background: #00ff88;
      box-shadow: 0 0 40px #00ff88, 0 0 80px #00ff4466;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 40px #00ff88, 0 0 80px #00ff4466; }
      50%       { box-shadow: 0 0 60px #00ff88, 0 0 120px #00ff4488; }
    }
    h1 { font-size: 2rem; letter-spacing: 0.3em; }
    .tag { font-size: 1.1rem; color: #00ff8899; letter-spacing: 0.2em; }
    .stats {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: center;
      color: #00ff88bb;
      font-size: 0.9rem;
    }
    .stats span { letter-spacing: 0.1em; }
  </style>
</head>
<body>
  <div class="dot"></div>
  <h1>GREENLIGHT</h1>
  <div class="tag">BULL BEAR SERVER — ONLINE</div>
  <div class="stats">
    <span>⏱ UPTIME: ${uptime}</span>
    <span>🤖 ACTIVE BOTS: ${botCount}</span>
    <span>📱 CONNECTED CLIENTS: ${clientCount}</span>
    <span>🌐 ${SERVER_URL}</span>
  </div>
</body>
</html>
  `);
});

/* ── WebSocket server — attached to same HTTP server ─────────── */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log(`[+] Client connected. Total: ${clients.size}`);

  /* Send welcome confirmation to APK */
  safeSend(socket, { event: 'server_ready', message: 'BULL BEAR backend connected.' });

  /* ── Incoming messages from APK ── */
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* START BOT */
    if (msg.action === 'start_bot') {
      const { botName, token, stake, sl, tp, maxRuns } = msg;
      if (!botName || !token || !stake) {
        safeSend(socket, { event: 'error', message: 'Missing required fields: botName, token, stake.' });
        return;
      }

      /* broadcast: sends events from bot engine back to this APK client */
      const broadcast = (eventName, data) => {
        safeSend(socket, { event: eventName, ...data });
      };

      /* onStop: called when bot stops itself */
      const onStop = (stoppedBotName) => {
        safeSend(socket, { event: 'bot_stopped', botName: stoppedBotName });
        console.log(`[BOT] ${stoppedBotName} stopped.`);
      };

      try {
        bots.launchBot({ botName, token, stake, sl, tp, maxRuns, broadcast, onStop });
        safeSend(socket, { event: 'bot_started', botName });
        console.log(`[BOT] ${botName} launched.`);
      } catch (err) {
        safeSend(socket, { event: 'error', message: `Failed to launch ${botName}: ${err.message}` });
      }
    }

    /* STOP BOT */
    if (msg.action === 'stop_bot') {
      const { botName } = msg;
      if (!botName) return;
      bots.stopBotByName(botName);
      safeSend(socket, { event: 'bot_stopped', botName });
      console.log(`[BOT] ${botName} manually stopped.`);
    }

    /* PING from APK (keep-alive from client side) */
    if (msg.action === 'ping') {
      safeSend(socket, { event: 'pong' });
    }
  });

  /* ── Client disconnected ── */
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[-] Client disconnected. Total: ${clients.size}`);
  });

  socket.on('error', (err) => {
    console.error('[WS ERROR]', err.message);
    clients.delete(socket);
  });
});

/* ── Start listening ─────────────────────────────────────────── */
httpServer.listen(PORT, () => {
  console.log(`\n🟢 BULL BEAR server running on port ${PORT}`);
  console.log(`🌐 Greenlight: ${SERVER_URL}\n`);
});

/* ── Keep-alive self-ping (prevents Render free tier sleep) ──── */
/* Pings every 4 minutes — Render sleeps after 15min inactivity */
const KEEP_ALIVE_MS = 4 * 60 * 1000;
setInterval(() => {
  if (SERVER_URL.startsWith('http')) {
    http.get(SERVER_URL, (res) => {
      console.log(`[KEEP-ALIVE] Self-ping OK — ${new Date().toISOString()}`);
      res.resume();
    }).on('error', (err) => {
      console.warn('[KEEP-ALIVE] Self-ping failed:', err.message);
    });
  }
}, KEEP_ALIVE_MS);

/* ── Helpers ─────────────────────────────────────────────────── */
function safeSend(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}
