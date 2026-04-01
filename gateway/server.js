/**
 * server.js — Gateway Service
 *
 * Responsibilities:
 *  - Accept WebSocket connections from browser clients
 *  - Maintain list of active WebSocket connections
 *  - Forward incoming strokes to the current Leader via POST /client-stroke
 *  - Expose POST /broadcast endpoint for Leader to push committed strokes
 *  - Broadcast committed strokes to all connected clients
 *  - Expose GET /health for health checks
 *
 * TODO (Week 2):
 *  - Set up Express HTTP server on process.env.PORT || 3000
 *  - Set up WebSocket server (ws library) on the same port
 *  - On new WS connection: add to clients list, send full-sync from leader
 *  - On WS message (type: "stroke"): call leaderTracker.forwardStroke(data)
 *  - POST /broadcast: receive committed stroke, broadcast to all WS clients
 *  - GET /health: return { status: "ok", leader: leaderTracker.getLeader() }
 *
 * TODO (Week 3):
 *  - Queue strokes during leader failover and replay on new leader discovery
 *  - Handle WS client disconnects gracefully (remove from clients list)
 */

const express      = require('express');
const http         = require('http');
const { WebSocketServer } = require('ws');
const leaderTracker = require('./leaderTracker');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Active WebSocket connections
const clients = new Set();

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[Gateway] Client connected. Total: ${clients.size}`);

  ws.on('message', (raw) => {
    // TODO (Week 2): Parse message, forward stroke to leader
    const msg = JSON.parse(raw);
    console.log('[Gateway] Received from client:', msg.type);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Gateway] Client disconnected. Total: ${clients.size}`);
  });
});

// ── HTTP: receive committed stroke from Leader → broadcast to clients ─────────
app.post('/broadcast', (req, res) => {
  // TODO (Week 2): Broadcast req.body.stroke to all WS clients
  console.log('[Gateway] /broadcast called — stroke index:', req.body?.stroke?.index);
  res.json({ success: true });
});

// ── HTTP: health check ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', leader: leaderTracker.getLeader() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Gateway] Listening on port ${PORT}`);
  leaderTracker.start();
});
