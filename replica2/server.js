/**
 * server.js — Replica HTTP Server
 *
 * Exposes all RAFT RPC endpoints and starts the RAFT state machine.
 *
 * Endpoints:
 *  POST /request-vote    — Candidate requests vote from peer
 *  POST /append-entries  — Leader replicates a log entry to follower
 *  POST /heartbeat       — Leader heartbeat to suppress follower elections
 *  POST /sync-log        — Leader sends missing entries to lagging follower
 *  POST /client-stroke   — Gateway forwards a client stroke (Leader only)
 *  GET  /status          — Current RAFT state: { id, state, term, leader, logLength, commitIndex }
 *  GET  /committed-log   — All committed strokes (used by Gateway for full-sync on client connect)
 */

const express = require('express');
const raft    = require('./raft');
const log     = require('./log');
const config  = require('./config');

const app = express();
app.use(express.json());

// ── RAFT RPC Endpoints ────────────────────────────────────────────────────────

app.post('/request-vote', (req, res) => {
  const result = raft.handleRequestVote(req.body);
  res.json(result);
});

app.post('/append-entries', (req, res) => {
  const result = raft.handleAppendEntries(req.body);
  res.json(result);
});

app.post('/heartbeat', (req, res) => {
  const result = raft.handleHeartbeat(req.body);
  res.json(result);
});

app.post('/sync-log', (req, res) => {
  const result = raft.handleSyncLog(req.body);
  res.json(result);
});

// ── Client Stroke (from Gateway) ──────────────────────────────────────────────

app.post('/client-stroke', async (req, res) => {
  const result = await raft.handleClientStroke(req.body.stroke);
  res.json(result);
});

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * GET /status
 * Returns the current observable RAFT state.
 * Shape (SRS §6.1): { id, state, term, leader, logLength, commitIndex }
 */
app.get('/status', (req, res) => {
  res.json(raft.getStatus());
});

// ── Committed Log (for Gateway full-sync) ─────────────────────────────────────

/**
 * GET /committed-log
 * Returns all committed stroke entries so the Gateway can push them
 * to a newly connected client via the "full-sync" WebSocket message.
 *
 * Response: { strokes: [ { index, points, color, width, ... } ] }
 */
app.get('/committed-log', (req, res) => {
  const committed = log.getCommitted();
  const strokes   = committed.map(e => ({ index: e.index, ...e.stroke }));
  res.json({ strokes });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.PORT, () => {
  console.log(`[${config.REPLICA_ID}] HTTP server listening on port ${config.PORT}`);
  raft.start();
});
