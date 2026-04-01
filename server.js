'use strict';

/**
 * server.js – Mini-RAFT Drawing Board server
 *
 * Usage:
 *   node server.js [--port=3000] [--id=1] [--peers=http://host:port,...]
 *
 * Examples:
 *   # Single-node (leader immediately):
 *   node server.js
 *
 *   # Three-node cluster:
 *   node server.js --port=3000 --id=1 --peers=http://localhost:3001,http://localhost:3002
 *   node server.js --port=3001 --id=2 --peers=http://localhost:3000,http://localhost:3002
 *   node server.js --port=3002 --id=3 --peers=http://localhost:3000,http://localhost:3001
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server: IOServer } = require('socket.io');
const { RaftNode } = require('./src/raft/RaftNode');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 3000, id: '1', peers: [] };
  for (const arg of args) {
    const [key, val] = arg.replace(/^--/, '').split('=');
    if (key === 'port') opts.port = parseInt(val, 10);
    else if (key === 'id') opts.id = val;
    else if (key === 'peers' && val)
      opts.peers = val.split(',').map((u) => u.trim()).filter(Boolean);
  }
  return opts;
}

const { port, id, peers } = parseArgs();

// ---------------------------------------------------------------------------
// Express + Socket.io setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: '*' },
});

// ---------------------------------------------------------------------------
// Trusted peers (used to validate leaderUrl before making outbound RPC calls)
// ---------------------------------------------------------------------------

const axios = require('axios');

// Set of trusted peer URLs derived from the CLI --peers argument.
// leaderUrl is only used for forwarding when it is in this set to prevent SSRF.
const trustedPeerUrls = new Set(peers);

/**
 * Returns the current leaderUrl only if it belongs to the configured peer set,
 * preventing SSRF from a compromised or misconfigured leader node.
 */
function trustedLeaderUrl() {
  const url = raft.leaderUrl;
  if (!url || !trustedPeerUrls.has(url)) return null;
  return url;
}

// ---------------------------------------------------------------------------
// RAFT node
// ---------------------------------------------------------------------------

const raft = new RaftNode(id, peers);
// Let the node know its own public URL so it can tell followers who the leader is
raft.leaderUrl = `http://localhost:${port}`;

// ---------------------------------------------------------------------------
// In-memory drawing state (applied strokes, for late-joining clients)
// ---------------------------------------------------------------------------

const committedStrokes = []; // Array of stroke objects

raft.on('committed', (stroke) => {
  committedStrokes.push(stroke);
  // Broadcast the committed stroke to every connected browser client
  io.emit('stroke', stroke);
});

raft.on('stateChange', (state) => {
  io.emit('raftState', state);
});

raft.on('leaderElected', (state) => {
  io.emit('raftState', state);
  console.log(`[RAFT] Node ${state.id} became LEADER for term ${state.term}`);
});

// ---------------------------------------------------------------------------
// RAFT RPC endpoints (called by peer nodes)
// ---------------------------------------------------------------------------

app.post('/raft/requestVote', (req, res) => {
  const result = raft.handleRequestVote(req.body);
  res.json(result);
});

app.post('/raft/appendEntries', (req, res) => {
  const result = raft.handleAppendEntries(req.body);
  res.json(result);
});

// Status endpoint (useful for debugging / health checks)
app.get('/raft/status', (_req, res) => {
  res.json(raft.getState());
});

// ---------------------------------------------------------------------------
// Socket.io – browser client events
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send the full drawing history so late joiners see existing strokes
  socket.emit('history', committedStrokes);

  // Send current RAFT state
  socket.emit('raftState', raft.getState());

  // Client wants to draw a stroke
  socket.on('draw', async (stroke) => {
    if (raft.isLeader()) {
      // This node is the leader – append directly
      await raft.appendStroke(stroke);
    } else {
      // Forward to the leader via HTTP (only if it's a trusted peer URL)
      const leaderUrl = trustedLeaderUrl();
      if (leaderUrl) {
        try {
          await axios.post(`${leaderUrl}/raft/clientDraw`, stroke, {
            timeout: 2000,
          });
        } catch {
          // Leader unreachable – emit error back to client
          socket.emit('error', { message: 'Leader unreachable, try again.' });
        }
      } else {
        socket.emit('error', { message: 'No leader elected yet, please wait.' });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ---------------------------------------------------------------------------
// Client-draw forwarding endpoint (used when a follower node proxies to leader)
// ---------------------------------------------------------------------------

app.post('/raft/clientDraw', async (req, res) => {
  if (!raft.isLeader()) {
    return res.status(503).json({ error: 'Not the leader' });
  }
  const stroke = req.body;
  const ok = await raft.appendStroke(stroke);
  res.json({ ok });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.on('error', (err) => {
  console.error(`[server] HTTP server error: ${err.message}`);
  process.exit(1);
});

httpServer.listen(port, () => {
  console.log(`[server] Node ${id} listening on http://localhost:${port}`);
  console.log(`[server] Peers: ${peers.length ? peers.join(', ') : '(none – single-node mode)'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  raft.stop();
  process.exit(0);
});
