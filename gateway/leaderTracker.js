/**
 * leaderTracker.js — Gateway Leader Discovery & Tracking
 *
 * Responsibilities:
 *  ✓ On startup, poll all replicas at GET /status to find the current leader
 *  ✓ Continuously re-poll every POLL_INTERVAL_MS to detect leader changes
 *  ✓ Store the current leader's base URL
 *  ✓ forwardStroke(stroke): POST stroke to leader /client-stroke
 *  ✓ On leader failure (HTTP error / timeout ≥ 2 s): queue stroke, re-discover, replay queue
 *  ✓ getLeader(): return current leader URL (used by server.js /health)
 *
 * Failure handling (FR-GW-07, FR-GW-08, FR-GW-09):
 *  - If leader is unreachable: stroke is queued, re-discovery runs immediately
 *  - Queued strokes are replayed in order once a new leader is found
 *  - Clients are NEVER disconnected during a leader change
 */

const axios = require('axios');

// ── Replica address list ──────────────────────────────────────────────────────
// Parsed from REPLICAS env var: "replica1:4001,replica2:4002,replica3:4003"
const REPLICAS = (process.env.REPLICAS || 'replica1:4001,replica2:4002,replica3:4003')
  .split(',')
  .map(r => `http://${r.trim()}`);

// ── Internal state ────────────────────────────────────────────────────────────
let currentLeader     = null;   // Base URL of current known leader, e.g. "http://replica1:4001"
let discoverInFlight  = false;  // Prevents concurrent discovery loops
let pollTimer         = null;   // Handle for the periodic poll interval

const strokeQueue     = [];     // Strokes queued during leader-less periods
const POLL_INTERVAL_MS  = 2000; // Periodic re-check interval (SRS §7.2)
const FORWARD_TIMEOUT_MS = 2000; // POST /client-stroke timeout (FR-GW-07)
const STATUS_TIMEOUT_MS  = 1000; // GET /status timeout per replica

// ── Leader Discovery ──────────────────────────────────────────────────────────

/**
 * Poll all replicas in order and set currentLeader to the first one
 * that reports state === "Leader".
 * After finding a new leader, replays any queued strokes.
 */
async function discoverLeader() {
  if (discoverInFlight) return; // Avoid concurrent discovery races
  discoverInFlight = true;

  console.log('[LeaderTracker] Discovering leader...');

  let found = null;

  for (const replicaUrl of REPLICAS) {
    try {
      const res = await axios.get(`${replicaUrl}/status`, { timeout: STATUS_TIMEOUT_MS });
      if (res.data && res.data.state === 'Leader') {
        found = replicaUrl;
        break;
      }
    } catch {
      // Replica unreachable — try next
    }
  }

  if (found) {
    const changed = (found !== currentLeader);
    currentLeader = found;
    if (changed) {
      console.log(`[LeaderTracker] Leader: ${currentLeader}`);
      // Replay any strokes that were queued during the leader-less window
      await replayQueue();
    }
  } else {
    if (currentLeader !== null) {
      console.warn('[LeaderTracker] No leader found — strokes will be queued');
    }
    currentLeader = null;
  }

  discoverInFlight = false;
}

/**
 * Replay queued strokes in order to the newly discovered leader.
 * Uses a draining loop so new strokes added during replay are also sent.
 */
async function replayQueue() {
  if (strokeQueue.length === 0) return;
  console.log(`[LeaderTracker] Replaying ${strokeQueue.length} queued stroke(s) to new leader`);

  while (strokeQueue.length > 0 && currentLeader) {
    const stroke = strokeQueue.shift();
    try {
      await axios.post(
        `${currentLeader}/client-stroke`,
        { stroke },
        { timeout: FORWARD_TIMEOUT_MS }
      );
      console.log('[LeaderTracker] Replayed queued stroke successfully');
    } catch (err) {
      console.warn(`[LeaderTracker] Replay failed: ${err.message} — re-queuing`);
      strokeQueue.unshift(stroke); // Put it back at front
      await discoverLeader();      // Try to find leader again
      break;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the leader tracker.
 * Runs an initial discovery immediately, then re-polls every POLL_INTERVAL_MS.
 * The periodic poll acts as a background watchdog — if the leader changes
 * (e.g. after election), we detect it within 2 s even without a failure.
 */
function start() {
  console.log(`[LeaderTracker] Starting — replicas: ${REPLICAS.join(', ')}`);
  discoverLeader(); // Initial discovery (async, non-blocking)
  pollTimer = setInterval(discoverLeader, POLL_INTERVAL_MS);
}

/**
 * Return the base URL of the current known leader, or null if unknown.
 */
function getLeader() {
  return currentLeader;
}

/**
 * Forward a stroke to the current leader via POST /client-stroke.
 *
 * Behaviour:
 *  - No leader known → queue stroke, trigger discovery (FR-GW-08)
 *  - Leader reachable → POST stroke, return
 *  - Leader fails (timeout / 5xx) → queue stroke, null out leader, re-discover,
 *    then replay queue once new leader found (FR-GW-07)
 */
async function forwardStroke(stroke) {
  // Case 1: No leader currently known
  if (!currentLeader) {
    console.warn('[LeaderTracker] No leader — queuing stroke');
    strokeQueue.push(stroke);
    discoverLeader(); // Kick off discovery (non-blocking)
    return { queued: true };
  }

  // Case 2: Forward to known leader
  try {
    const res = await axios.post(
      `${currentLeader}/client-stroke`,
      { stroke },
      { timeout: FORWARD_TIMEOUT_MS }
    );

    if (!res.data.success) {
      // Leader responded but reported an error (e.g. "not leader" after step-down)
      console.warn(
        `[LeaderTracker] Leader rejected stroke: ${res.data.error} — re-discovering`
      );
      currentLeader = null;
      strokeQueue.push(stroke);
      await discoverLeader();
      return { queued: true };
    }

    return { success: true, index: res.data.index };

  } catch (err) {
    // Case 3: Leader unreachable (timeout / network error)
    console.error(`[LeaderTracker] Leader unreachable (${err.message}) — queuing stroke, re-discovering`);
    currentLeader = null;
    strokeQueue.push(stroke);
    await discoverLeader(); // This will replay the queue if a new leader is found
    return { queued: true };
  }
}

module.exports = { start, getLeader, forwardStroke };
