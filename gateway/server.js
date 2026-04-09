/**
 * server.js — Gateway Service
 *
 * Responsibilities:
 *  ✓ Accept WebSocket connections from browser clients
 *  ✓ Maintain Set of active WebSocket connections
 *  ✓ On new connection: send full-sync of all committed strokes from leader
 *  ✓ On WS message { type:"stroke" }: forward to current leader via leaderTracker
 *  ✓ On WS message { type:"ping" }: pong back (connection keep-alive)
 *  ✓ On WS close/error: remove from clients set
 *  ✓ POST /broadcast: receive committed stroke from leader → broadcast to all clients
 *  ✓ GET  /health: return gateway liveness + current leader
 *  ✓ GET  /status: alias for /health (used by monitoring)
 *
 * WebSocket Message Shapes (SRS §6.3):
 *
 *  Client → Gateway:
 *    { type: "stroke", data: { points, color, width } }
 *    { type: "ping" }
 *
 *  Gateway → Client:
 *    { type: "stroke-committed", data: { index, points, color, width, userId? } }
 *    { type: "full-sync",        data: { strokes: [ { index, points, color, width } ] } }
 *    { type: "pong" }
 *    { type: "error",            data: { message } }
 */

const express       = require('express');
const http          = require('http');
const { WebSocketServer, OPEN } = require('ws');
const leaderTracker = require('./leaderTracker');

// ── Express + HTTP + WebSocket setup ──────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Client registry ───────────────────────────────────────────────────────────
/**
 * All active WebSocket connections. We use a Set so add/delete are O(1).
 * Each ws object is augmented with an `id` for logging.
 */
const clients = new Set();
let clientIdCounter = 0;

/** Send a JSON message to a single WebSocket client (safe — checks OPEN state). */
function sendToClient(ws, payload) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Broadcast a JSON message to every connected client. */
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === OPEN) {
      ws.send(msg);
      sent++;
    }
  }
  return sent;
}

// ── Full-sync helper ──────────────────────────────────────────────────────────
const axios = require('axios');

/**
 * Ask the leader for its committed log and send it to a newly connected client.
 *
 * Goes directly to GET /committed-log on the known leader — no pre-flight /status
 * call needed (leaderTracker already guarantees the URL is a current Leader).
 * Sends an empty full-sync on any failure so the client can still start drawing.
 */
async function sendFullSync(ws) {
  const leaderUrl = leaderTracker.getLeader();

  if (!leaderUrl) {
    // No leader yet known — send empty sync; client will receive strokes
    // via broadcast once the tracker finds a leader.
    sendToClient(ws, { type: 'full-sync', data: { strokes: [] } });
    console.log(`[Gateway] Full-sync: no leader yet — sent empty sync to client ${ws.id}`);
    return;
  }

  try {
    const logRes  = await axios.get(`${leaderUrl}/committed-log`, { timeout: 2000 });
    const strokes = logRes.data.strokes || [];
    sendToClient(ws, { type: 'full-sync', data: { strokes } });
    console.log(`[Gateway] Full-sync → client ${ws.id}: ${strokes.length} stroke(s) from ${leaderUrl}`);
  } catch (err) {
    // Leader unreachable or /committed-log not yet available — degrade gracefully
    console.warn(`[Gateway] Full-sync failed for client ${ws.id}: ${err.message}`);
    sendToClient(ws, { type: 'full-sync', data: { strokes: [] } });
  }
}

// ── WebSocket event handling ───────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.id = ++clientIdCounter;
  clients.add(ws);

  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`[Gateway] Client #${ws.id} connected from ${clientIp} — total: ${clients.size}`);

  // Send full canvas state immediately on connect (FR-FE-10, FR-GW-05)
  sendFullSync(ws);

  // ── Incoming messages from client ─────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[Gateway] Client #${ws.id} sent invalid JSON — ignored`);
      sendToClient(ws, { type: 'error', data: { message: 'Invalid JSON' } });
      return;
    }

    switch (msg.type) {

      case 'stroke':
        // Validate minimal stroke shape before forwarding
        if (!msg.data || !Array.isArray(msg.data.points) || msg.data.points.length === 0) {
          sendToClient(ws, { type: 'error', data: { message: 'Invalid stroke payload' } });
          return;
        }
        console.log(`[Gateway] Client #${ws.id} sent stroke — forwarding to leader`);
        // Forward to leader — leaderTracker handles queuing if no leader is known
        leaderTracker.forwardStroke(msg.data).catch((err) => {
          console.error(`[Gateway] forwardStroke error: ${err.message}`);
        });
        break;

      case 'ping':
        sendToClient(ws, { type: 'pong' });
        break;

      default:
        console.warn(`[Gateway] Client #${ws.id} sent unknown message type: "${msg.type}"`);
    }
  });

  // ── Connection closed ──────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    clients.delete(ws);
    console.log(
      `[Gateway] Client #${ws.id} disconnected` +
      ` (code=${code}, reason=${reason || 'none'}) — remaining: ${clients.size}`
    );
  });

  // ── Connection error ───────────────────────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[Gateway] Client #${ws.id} error: ${err.message}`);
    clients.delete(ws);
  });
});

// ── HTTP: Leader → Gateway → All clients ──────────────────────────────────────
/**
 * POST /broadcast
 * Called by the Leader after committing a log entry.
 * Pushes the committed stroke to every connected WebSocket client.
 *
 * Body: { stroke: { index, points, color, width, userId? } }
 * Shape matches SRS §6.2 /broadcast spec.
 */
app.post('/broadcast', (req, res) => {
  const { stroke } = req.body;

  if (!stroke || stroke.index === undefined) {
    return res.status(400).json({ success: false, error: 'Missing stroke or stroke.index' });
  }

  const sent = broadcast({ type: 'stroke-committed', data: stroke });

  console.log(
    `[Gateway] /broadcast — index=${stroke.index} — pushed to ${sent}/${clients.size} client(s)`
  );

  res.json({ success: true, clientsNotified: sent });
});

// ── HTTP: Health / Status ─────────────────────────────────────────────────────
/**
 * GET /health
 * Returns gateway liveness, the currently tracked leader URL, connected
 * client count, and pending stroke queue depth.
 * Shape: { status, leader, clients, queueDepth }
 */
app.get('/health', (req, res) => {
  const stats = leaderTracker.getStats();
  res.json({
    status:     'ok',
    leader:     stats.leader,
    clients:    clients.size,
    queueDepth: stats.queueDepth,
  });
});

app.get('/status', (req, res) => {
  const stats = leaderTracker.getStats();
  res.json({
    status:     'ok',
    leader:     stats.leader,
    clients:    clients.size,
    queueDepth: stats.queueDepth,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Log every leader transition detected by the tracker
leaderTracker.onLeaderChange((newLeader, prevLeader) => {
  if (newLeader) {
    console.log(`[Gateway] Leader changed: ${prevLeader || 'none'} → ${newLeader}`);
  } else {
    console.warn(`[Gateway] Leader lost (was ${prevLeader}) — strokes will be queued`);
  }
});

server.listen(PORT, () => {
  console.log(`[Gateway] ── WebSocket Gateway starting ────────────────────────`);
  console.log(`[Gateway]    HTTP + WS port : ${PORT}`);
  console.log(`[Gateway]    Replicas       : ${process.env.REPLICAS || '(default)'}`);
  console.log(`[Gateway] ────────────────────────────────────────────────────────`);
  leaderTracker.start();
});
