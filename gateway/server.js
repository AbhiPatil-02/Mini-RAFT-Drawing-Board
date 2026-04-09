/**
 * server.js — Gateway Service
 *
 * Responsibilities:
 *  ✓ Accept WebSocket connections from browser clients
 *  ✓ Maintain Set of active WebSocket connections
 *  ✓ On new connection: send full-sync of all committed strokes from leader
 *    (retries once against the new leader if the first attempt fails during failover)
 *  ✓ On WS message { type:"stroke" }: forward to current leader via leaderTracker
 *  ✓ On WS message { type:"ping" }: pong back (connection keep-alive)
 *  ✓ On WS close/error: remove from clients set
 *  ✓ POST /broadcast: receive committed stroke from leader → broadcast to all clients
 *  ✓ GET  /health: return gateway liveness + current leader + failoverActive flag
 *  ✓ GET  /status: alias for /health (used by monitoring)
 *
 *  ✓ GRACEFUL FAILOVER — no client disconnects during leader transitions:
 *      - leaderTracker queues strokes and replays them serially once a new leader is found
 *      - failover start/end broadcasts 'leader-changing' / 'leader-restored' WS messages
 *        so the frontend can show a status indicator without closing the connection
 *      - sendFullSync retries against a newly discovered leader if the first attempt
 *        fails (handles the case where a client connects exactly during failover)
 *
 * WebSocket Message Shapes (SRS §6.3):
 *
 *  Client → Gateway:
 *    { type: "stroke", data: { points, color, width } }
 *    { type: "ping" }
 *
 *  Gateway → Client:
 *    { type: "stroke-committed",  data: { index, points, color, width, userId? } }
 *    { type: "full-sync",         data: { strokes: [ { index, points, color, width } ] } }
 *    { type: "leader-changing",   data: { message } }   ← NEW: failover started
 *    { type: "leader-restored",   data: { leader } }    ← NEW: failover ended
 *    { type: "pong" }
 *    { type: "error",             data: { message } }
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
 * Full-sync retry wait (ms).  If the leader just died, we wait briefly and
 * then try again against whatever leader the tracker has found by then.
 */
const FULL_SYNC_RETRY_WAIT_MS  = 1500;
const FULL_SYNC_RETRY_ATTEMPTS = 2;

/**
 * Ask the leader for its committed log and send it to a newly connected client.
 *
 * Goes directly to GET /committed-log on the known leader — no pre-flight /status
 * call needed (leaderTracker already guarantees the URL is a current Leader).
 *
 * Retry logic (graceful failover):
 *   If the first attempt fails (leader just died), we wait FULL_SYNC_RETRY_WAIT_MS
 *   and retry — by then leaderTracker will usually have elected a new leader.
 *   After FULL_SYNC_RETRY_ATTEMPTS failures we fall back to an empty sync so
 *   the client can still start drawing (it will receive future strokes via broadcast).
 */
async function sendFullSync(ws) {
  for (let attempt = 1; attempt <= FULL_SYNC_RETRY_ATTEMPTS; attempt++) {
    const leaderUrl = leaderTracker.getLeader();

    if (!leaderUrl) {
      if (attempt < FULL_SYNC_RETRY_ATTEMPTS) {
        // Still in failover — wait for the tracker to find a new leader
        console.log(
          `[Gateway] Full-sync attempt ${attempt}: no leader yet — ` +
          `waiting ${FULL_SYNC_RETRY_WAIT_MS}ms for failover to resolve`
        );
        await new Promise(r => setTimeout(r, FULL_SYNC_RETRY_WAIT_MS));
        continue;
      }
      // Final attempt, still no leader — send empty sync
      sendToClient(ws, { type: 'full-sync', data: { strokes: [] } });
      console.log(`[Gateway] Full-sync: no leader — sent empty sync to client ${ws.id}`);
      return;
    }

    try {
      const logRes  = await axios.get(`${leaderUrl}/committed-log`, { timeout: 2000 });
      const strokes = logRes.data.strokes || [];
      sendToClient(ws, { type: 'full-sync', data: { strokes } });
      console.log(
        `[Gateway] Full-sync → client ${ws.id}: ${strokes.length} stroke(s) from ${leaderUrl}` +
        (attempt > 1 ? ` (after ${attempt} attempts)` : '')
      );
      return; // Success
    } catch (err) {
      console.warn(
        `[Gateway] Full-sync attempt ${attempt} failed for client ${ws.id}: ${err.message}`
      );
      if (attempt < FULL_SYNC_RETRY_ATTEMPTS) {
        // Leader became unreachable — wait for tracker to re-discover
        await new Promise(r => setTimeout(r, FULL_SYNC_RETRY_WAIT_MS));
      }
    }
  }

  // All attempts failed — send empty sync so client can still draw
  sendToClient(ws, { type: 'full-sync', data: { strokes: [] } });
  console.warn(`[Gateway] Full-sync: all ${FULL_SYNC_RETRY_ATTEMPTS} attempts failed for client ${ws.id} — sent empty sync`);
}

// ── WebSocket event handling ───────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.id = ++clientIdCounter;
  clients.add(ws);

  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`[Gateway] Client #${ws.id} connected from ${clientIp} — total: ${clients.size}`);

  // If a failover is in progress right now, tell this client immediately so
  // it can show a "leader changing" indicator in the UI while we do the full-sync
  if (leaderTracker.isFailoverInProgress()) {
    sendToClient(ws, {
      type: 'leader-changing',
      data: { message: 'Leader election in progress — strokes will be delivered shortly' },
    });
  }

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
 * client count, pending stroke queue depth, and whether a failover is in progress.
 * Shape: { status, leader, clients, queueDepth, failoverActive }
 */
app.get('/health', (req, res) => {
  const stats = leaderTracker.getStats();
  res.json({
    status:        'ok',
    leader:        stats.leader,
    clients:       clients.size,
    queueDepth:    stats.queueDepth,
    failoverActive: stats.failoverActive,
  });
});

app.get('/status', (req, res) => {
  const stats = leaderTracker.getStats();
  res.json({
    status:        'ok',
    leader:        stats.leader,
    clients:       clients.size,
    queueDepth:    stats.queueDepth,
    failoverActive: stats.failoverActive,
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

/**
 * Broadcast failover state changes to ALL connected WebSocket clients.
 *
 *  isActive=true  → leadership is changing; strokes are queued
 *                   clients receive  { type: 'leader-changing', data: { message } }
 *                   so they can show an "election in progress" status pill
 *                   WITHOUT closing the WebSocket connection.
 *
 *  isActive=false → new leader found, queue drained; system is healthy again
 *                   clients receive  { type: 'leader-restored', data: { leader } }
 *                   so they can update the leader badge and hide the indicator.
 */
leaderTracker.onFailoverStateChange((isActive) => {
  if (isActive) {
    console.log('[Gateway] ⚡ Failover started — broadcasting leader-changing to all clients');
    broadcast({
      type: 'leader-changing',
      data: { message: 'Leader election in progress — your strokes are safely queued' },
    });
  } else {
    const newLeader = leaderTracker.getLeader();
    console.log(`[Gateway] ✅ Failover complete — broadcasting leader-restored (${newLeader})`);
    broadcast({
      type: 'leader-restored',
      data: { leader: newLeader },
    });
  }
});

server.listen(PORT, () => {
  console.log(`[Gateway] ── WebSocket Gateway starting ────────────────────────`);
  console.log(`[Gateway]    HTTP + WS port : ${PORT}`);
  console.log(`[Gateway]    Replicas       : ${process.env.REPLICAS || '(default)'}`);
  console.log(`[Gateway] ────────────────────────────────────────────────────────`);
  leaderTracker.start();
});
