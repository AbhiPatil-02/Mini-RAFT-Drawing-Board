/**
 * leaderTracker.js — Gateway Leader Discovery & Tracking
 *
 * Responsibilities:
 *  ✓ On startup, poll all replicas simultaneously at GET /status to find
 *    the current leader (parallel — first Leader response wins)
 *  ✓ Continuously re-poll every POLL_INTERVAL_MS to detect leader changes
 *  ✓ Store the current leader's base URL
 *  ✓ forwardStroke(stroke): POST stroke to leader /client-stroke
 *  ✓ On leader failure (HTTP error / timeout ≥ 2 s): queue stroke, re-discover, replay queue
 *  ✓ Leader-hint fast-path: if a replica responds { error: 'not leader', leader: 'replicaX' },
 *    use that URL directly instead of re-polling (reduces failover latency significantly)
 *  ✓ Queue depth guard: cap queued strokes at MAX_QUEUE_SIZE (drops oldest)
 *  ✓ Replay retry limit: each queued stroke is retried at most MAX_REPLAY_RETRIES times
 *  ✓ getLeader(): return current leader URL (used by server.js /health)
 *  ✓ onLeaderChange(cb): register a callback fired whenever the tracked leader changes
 *
 * Failure handling (FR-GW-07, FR-GW-08, FR-GW-09):
 *  - If leader is unreachable: stroke is queued, re-discovery runs immediately
 *  - Queued strokes are replayed in order once a new leader is found
 *  - Clients are NEVER disconnected during a leader change
 *
 * Performance:
 *  - discoverLeader() polls all replicas in PARALLEL — leader found in one RTT
 *    regardless of replica ordering, not up-to-(worst RTT × N) as with sequential polling
 */

'use strict';

const axios = require('axios');

// ── Replica address list ──────────────────────────────────────────────────────
// Parsed from REPLICAS env var: "replica1:4001,replica2:4002,replica3:4003"
const REPLICAS = (process.env.REPLICAS || 'replica1:4001,replica2:4002,replica3:4003')
  .split(',')
  .map(r => `http://${r.trim()}`);

// ── Constants ─────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = 2000;  // Background watchdog re-check interval (SRS §7.2)
const FORWARD_TIMEOUT_MS = 2000;  // POST /client-stroke max wait (FR-GW-07)
const STATUS_TIMEOUT_MS  = 1000;  // GET /status max wait per replica
const MAX_QUEUE_SIZE     = 100;   // Maximum strokes queued during leader-less window
const MAX_REPLAY_RETRIES = 3;     // Max delivery attempts per queued stroke

// ── Internal state ────────────────────────────────────────────────────────────
let currentLeader     = null;   // Base URL e.g. "http://replica1:4001", or null
let discoverInFlight  = false;  // Prevents concurrent discovery races
let pollTimer         = null;   // Handle for the periodic poll setInterval

const strokeQueue     = [];     // Pending strokes during leader-less periods
let leaderChangeCallback = null; // Optional external change listener

// ── Leader Change Notification ────────────────────────────────────────────────

/**
 * Register a callback fired whenever the tracked leader URL changes (including → null).
 * server.js uses this to log leader transitions.
 */
function onLeaderChange(cb) {
  leaderChangeCallback = cb;
}

function _setLeader(newUrl) {
  if (newUrl === currentLeader) return; // No change
  const prev = currentLeader;
  currentLeader = newUrl;
  if (leaderChangeCallback) {
    try { leaderChangeCallback(newUrl, prev); } catch {}
  }
}

// ── Parallel Discovery ────────────────────────────────────────────────────────

/**
 * Poll a single replica for its /status.
 * Resolves with the replica's base URL if it reports state === "Leader".
 * Rejects otherwise (unreachable, follower, error).
 */
async function _pollOne(replicaUrl) {
  const res = await axios.get(`${replicaUrl}/status`, { timeout: STATUS_TIMEOUT_MS });
  if (res.data && res.data.state === 'Leader') {
    return replicaUrl;
  }
  throw new Error(`${replicaUrl} is not Leader (state=${res.data?.state})`);
}

/**
 * Poll all replicas IN PARALLEL and set currentLeader to the first one
 * that reports state === "Leader" (Promise.any — resolves on first success).
 *
 * This is significantly faster than sequential polling:
 *   - Sequential worst case: STATUS_TIMEOUT_MS × N replicas
 *   - Parallel: one network RTT regardless of replica count
 *
 * After finding a new leader, replays any queued strokes.
 */
async function discoverLeader() {
  if (discoverInFlight) return; // Guard against concurrent invocations
  discoverInFlight = true;

  console.log('[LeaderTracker] Discovering leader (parallel poll)...');

  try {
    // Promise.any resolves with the FIRST fulfilled value (first Leader found).
    // If ALL replicas are unreachable / non-leader, it throws AggregateError.
    const found = await Promise.any(REPLICAS.map(_pollOne));

    const changed = (found !== currentLeader);
    _setLeader(found);
    console.log(`[LeaderTracker] Leader: ${currentLeader}` + (changed ? ' [NEW]' : ''));

    if (changed) {
      // Replay any strokes that were queued during the leader-less window
      await replayQueue();
    }
  } catch {
    // AggregateError — no replica responded as Leader
    if (currentLeader !== null) {
      console.warn('[LeaderTracker] No leader found — strokes will be queued');
    }
    _setLeader(null);
  } finally {
    discoverInFlight = false;
  }
}

/**
 * Fast-path: a replica told us directly who the leader is (via the "leader"
 * field in a non-leader error response).  Verify the hint is actually a Leader
 * before committing to it — avoids trusting stale info from a lagging follower.
 *
 * Returns the verified URL, or null if verification fails.
 */
async function _verifyHint(hintUrl) {
  try {
    const res = await axios.get(`${hintUrl}/status`, { timeout: STATUS_TIMEOUT_MS });
    if (res.data && res.data.state === 'Leader') {
      return hintUrl;
    }
  } catch {}
  return null;
}

// ── Stroke Queue Helpers ──────────────────────────────────────────────────────

function _enqueue(stroke) {
  if (strokeQueue.length >= MAX_QUEUE_SIZE) {
    // Drop the oldest entry to prevent unbounded memory growth
    const dropped = strokeQueue.shift();
    console.warn(
      `[LeaderTracker] Queue full (${MAX_QUEUE_SIZE}) — dropped oldest stroke` +
      ` (points=${dropped?.points?.length ?? '?'})`
    );
  }
  strokeQueue.push({ stroke, retries: 0 });
}

/**
 * Replay queued strokes in order to the newly discovered leader.
 * Each stroke is retried up to MAX_REPLAY_RETRIES times before being discarded.
 * Uses a draining loop so strokes added during replay are also processed.
 */
async function replayQueue() {
  if (strokeQueue.length === 0) return;
  console.log(`[LeaderTracker] Replaying ${strokeQueue.length} queued stroke(s) to ${currentLeader}`);

  while (strokeQueue.length > 0 && currentLeader) {
    const item = strokeQueue[0]; // Peek — only shift on success or exhaustion

    if (item.retries >= MAX_REPLAY_RETRIES) {
      strokeQueue.shift();
      console.warn(
        `[LeaderTracker] Stroke exhausted ${MAX_REPLAY_RETRIES} retries — discarding` +
        ` (points=${item.stroke?.points?.length ?? '?'})`
      );
      continue;
    }

    item.retries += 1;

    try {
      const res = await axios.post(
        `${currentLeader}/client-stroke`,
        { stroke: item.stroke },
        { timeout: FORWARD_TIMEOUT_MS }
      );

      if (!res.data.success) {
        // The node we thought was leader rejected it — use hint or re-discover
        console.warn(`[LeaderTracker] Replay rejected by ${currentLeader}: ${res.data.error}`);
        const resolved = await _resolveLeaderFromHint(res.data.leader);
        if (!resolved) {
          // Could not find a new leader — stop draining, leave item in queue
          _setLeader(null);
          break;
        }
        // Leader updated — loop will retry this item against the new leader
        continue;
      }

      strokeQueue.shift(); // Successfully delivered → remove from queue
      console.log(`[LeaderTracker] Replayed queued stroke (index=${res.data.index})`);
    } catch (err) {
      console.warn(`[LeaderTracker] Replay failed (attempt ${item.retries}): ${err.message}`);
      _setLeader(null);
      await discoverLeader(); // Attempt to find a new leader
      if (!currentLeader) break; // Still no leader — stop replaying
    }
  }
}

// ── Leader Resolution Helpers ─────────────────────────────────────────────────

/**
 * Given a hint URL from a "not leader" response body, try to fast-path to
 * the correct leader.  Falls back to full discoverLeader() if the hint fails.
 *
 * Returns true if a leader is now known, false otherwise.
 */
async function _resolveLeaderFromHint(hintLeaderId) {
  if (hintLeaderId) {
    // The hint may be a plain replicaId string ("replica1") or a full URL
    const hintUrl = hintLeaderId.startsWith('http')
      ? hintLeaderId
      : REPLICAS.find(u => u.includes(hintLeaderId)) || null;

    if (hintUrl) {
      console.log(`[LeaderTracker] Trying leader hint: ${hintUrl}`);
      const verified = await _verifyHint(hintUrl);
      if (verified) {
        _setLeader(verified);
        console.log(`[LeaderTracker] Leader confirmed via hint: ${currentLeader}`);
        return true;
      }
    }
  }

  // Hint failed or not provided — fall back to full parallel discovery
  await discoverLeader();
  return currentLeader !== null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the leader tracker.
 * Runs an initial discovery immediately, then re-polls every POLL_INTERVAL_MS.
 * The periodic poll acts as a background watchdog — if the leader changes
 * (e.g. after a kill -9), the gateway detects it within POLL_INTERVAL_MS.
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
 *  - No leader known         → queue stroke, trigger discovery (FR-GW-08)
 *  - Leader reachable        → POST stroke, return result
 *  - Leader says "not leader"→ use leader hint to fast-path re-discovery (FR-GW-09)
 *  - Leader unreachable      → queue stroke, null out leader, re-discover,
 *                              replay queue once new leader found (FR-GW-07)
 */
async function forwardStroke(stroke) {
  // ── Case 1: No leader currently known ──────────────────────────────────────
  if (!currentLeader) {
    console.warn('[LeaderTracker] No leader — queuing stroke');
    _enqueue(stroke);
    discoverLeader(); // Kick off discovery (non-blocking)
    return { queued: true };
  }

  // ── Case 2: Forward to known leader ────────────────────────────────────────
  try {
    const res = await axios.post(
      `${currentLeader}/client-stroke`,
      { stroke },
      { timeout: FORWARD_TIMEOUT_MS }
    );

    if (!res.data.success) {
      // Leader responded but it's no longer the leader (e.g. stepped down mid-term)
      console.warn(
        `[LeaderTracker] Leader rejected stroke: "${res.data.error}" — resolving via hint`
      );
      _setLeader(null);
      _enqueue(stroke);
      await _resolveLeaderFromHint(res.data.leader);
      return { queued: true };
    }

    return { success: true, index: res.data.index };

  } catch (err) {
    // ── Case 3: Leader unreachable (timeout / network error) ─────────────────
    console.error(
      `[LeaderTracker] Leader unreachable (${err.message}) — queuing stroke, re-discovering`
    );
    _setLeader(null);
    _enqueue(stroke);
    await discoverLeader(); // Will replay the queue once a new leader is found
    return { queued: true };
  }
}

/**
 * Return a snapshot of internal state — useful for diagnostics / testing.
 */
function getStats() {
  return {
    leader:     currentLeader,
    queueDepth: strokeQueue.length,
    replicas:   REPLICAS,
  };
}

module.exports = { start, getLeader, forwardStroke, onLeaderChange, getStats };
