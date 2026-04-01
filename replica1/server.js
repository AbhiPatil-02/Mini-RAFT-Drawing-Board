/**
 * server.js — Replica HTTP Server
 *
 * Exposes all RAFT RPC endpoints and starts the RAFT state machine.
 *
 * Endpoints:
 *  POST /request-vote   — Candidate requests vote
 *  POST /append-entries — Leader replicates log entry
 *  POST /heartbeat      — Leader heartbeat
 *  POST /sync-log       — Leader sends missing entries to lagging follower
 *  POST /client-stroke  — Gateway forwards client stroke (Leader only)
 *  GET  /status         — Current RAFT state (for Gateway + debugging)
 */

const express = require('express');
const raft    = require('./raft');
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

app.get('/status', (req, res) => {
  res.json(raft.getStatus());
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.PORT, () => {
  console.log(`[${config.REPLICA_ID}] HTTP server listening on port ${config.PORT}`);
  raft.start();
});
