/**
 * leaderTracker.js — Gateway Leader Discovery & Tracking
 *
 * Responsibilities:
 *  - On startup, poll all replicas at GET /status to find the current leader
 *  - Store the current leader's URL
 *  - Expose forwardStroke(stroke) to POST stroke to the leader
 *  - On leader HTTP failure, re-poll all replicas to discover the new leader
 *
 * TODO (Week 2):
 *  - Implement start(): poll all REPLICAS env var addresses at /status
 *  - Implement getLeader(): return current leader URL
 *  - Implement forwardStroke(stroke): POST to leader /client-stroke
 *  - On 5xx / timeout: call discoverLeader() again
 *
 * TODO (Week 3):
 *  - Queue strokes when no leader is known
 *  - Replay queued strokes once a new leader is discovered
 */

const axios = require('axios');

// Parse REPLICAS env var: "replica1:4001,replica2:4002,replica3:4003"
const REPLICAS = (process.env.REPLICAS || 'replica1:4001,replica2:4002,replica3:4003')
  .split(',')
  .map(r => `http://${r.trim()}`);

let currentLeader = null;
const strokeQueue = [];
const POLL_INTERVAL_MS = 2000;

/**
 * Poll all replicas to find the current leader.
 */
async function discoverLeader() {
  console.log('[LeaderTracker] Discovering leader...');
  for (const replicaUrl of REPLICAS) {
    try {
      const res = await axios.get(`${replicaUrl}/status`, { timeout: 1000 });
      if (res.data.state === 'Leader') {
        currentLeader = replicaUrl;
        console.log(`[LeaderTracker] Leader found: ${currentLeader}`);
        return;
      }
    } catch {
      // Replica unreachable — try next
    }
  }
  console.warn('[LeaderTracker] No leader found. Will retry...');
  currentLeader = null;
}

/**
 * Start the leader tracker: initial discovery + periodic re-check.
 */
function start() {
  discoverLeader();
  setInterval(discoverLeader, POLL_INTERVAL_MS);
}

/**
 * Return the current known leader URL.
 */
function getLeader() {
  return currentLeader;
}

/**
 * Forward a stroke to the current leader.
 * TODO (Week 2): Handle leader failure → trigger re-discovery → queue + replay
 */
async function forwardStroke(stroke) {
  if (!currentLeader) {
    console.warn('[LeaderTracker] No leader available — queuing stroke');
    strokeQueue.push(stroke);
    return;
  }
  try {
    await axios.post(`${currentLeader}/client-stroke`, { stroke }, { timeout: 2000 });
  } catch (err) {
    console.error('[LeaderTracker] Failed to reach leader — re-discovering', err.message);
    currentLeader = null;
    strokeQueue.push(stroke);
    await discoverLeader();
    // TODO (Week 3): Replay strokeQueue after discovery
  }
}

module.exports = { start, getLeader, forwardStroke };
