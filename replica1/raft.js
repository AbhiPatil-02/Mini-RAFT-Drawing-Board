/**
 * raft.js — Mini-RAFT State Machine
 *
 * States: Follower | Candidate | Leader
 *
 * Implements (Week 2):
 *  ✓ becomeFollower()        — step down, reset timers, clear voted state
 *  ✓ becomeCandidate()       — increment term, vote for self, stop heartbeats
 *  ✓ becomeLeader()          — start heartbeat interval, send immediate heartbeat
 *  ✓ startElection()         — parallel RequestVote, majority check, step-down on higher term
 *  ✓ sendHeartbeats()        — POST /heartbeat to all peers; step down if higher term seen
 *  ✓ handleRequestVote()     — full log-up-to-date check (lastLogTerm + lastLogIndex)
 *  ✓ handleHeartbeat()       — reset timer, update term, advance commitIndex
 *  ✓ handleAppendEntries()   — consistency check, conflict truncation, append, advance commitIndex
 *  ✓ handleClientStroke()    — append → parallel AppendEntries → majority ACK → commit → notify Gateway
 *  ✓ handleSyncLog()         — bulk catch-up: append all missing entries from leader
 *  ✓ triggerSyncLog()        — leader sends missing entries to a lagging follower
 *  ✓ notifyGateway()         — POST /broadcast to Gateway after commit
 */

const axios  = require('axios');
const config = require('./config');
const log    = require('./log');

// ── State variables ───────────────────────────────────────────────────────────
let state         = 'Follower';  // 'Follower' | 'Candidate' | 'Leader'
let currentTerm   = 0;
let votedFor      = null;        // replicaId string or null
let commitIndex   = 0;
let currentLeader = null;

let electionTimer      = null;
let heartbeatTimer     = null;
let electionInProgress = false; // Guard against re-entrant election calls

// ── Cluster constants ─────────────────────────────────────────────────────────
// Total nodes = self + peers (3 for standard setup)
const CLUSTER_SIZE = config.PEERS.length + 1;
const MAJORITY     = Math.floor(CLUSTER_SIZE / 2) + 1; // 2 of 3

// ── Timer helpers ─────────────────────────────────────────────────────────────

function randomElectionTimeout() {
  return Math.floor(
    Math.random() * (config.ELECTION_TIMEOUT_MAX_MS - config.ELECTION_TIMEOUT_MIN_MS)
    + config.ELECTION_TIMEOUT_MIN_MS
  );
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, randomElectionTimeout());
}

function clearElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = null;
}

function clearHeartbeatTimer() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ── State Transitions ─────────────────────────────────────────────────────────

/**
 * Transition to Follower.
 * Called on: boot, higher-term RPC received, lost election, step-down from Leader.
 * Resets votedFor so this node can vote again in the new term.
 */
function becomeFollower(term) {
  const prev = state;
  state       = 'Follower';
  currentTerm = term;
  votedFor    = null;
  clearHeartbeatTimer();
  resetElectionTimer(); // Start waiting for a heartbeat from the leader
  console.log(
    `[RAFT][${config.REPLICA_ID}] → FOLLOWER  (term ${term})` +
    (prev === 'Leader' ? ' [stepped down from Leader]' : '')
  );
}

/**
 * Transition to Candidate.
 * Increments term, self-votes, stops heartbeat sender.
 * Actual vote-request RPCs are sent by startElection() right after.
 */
function becomeCandidate() {
  state       = 'Candidate';
  currentTerm += 1;
  votedFor    = config.REPLICA_ID; // vote for self
  clearHeartbeatTimer();
  console.log(`[RAFT][${config.REPLICA_ID}] → CANDIDATE (term ${currentTerm})`);
}

/**
 * Transition to Leader.
 * Stops election timer, starts heartbeat interval, sends an immediate heartbeat.
 */
function becomeLeader() {
  state         = 'Leader';
  currentLeader = config.REPLICA_ID;
  clearElectionTimer(); // Leaders never wait for elections
  sendHeartbeats();     // Assert authority immediately
  heartbeatTimer = setInterval(sendHeartbeats, config.HEARTBEAT_INTERVAL_MS);
  console.log(
    `[RAFT][${config.REPLICA_ID}] → LEADER    (term ${currentTerm})` +
    ` | cluster: ${CLUSTER_SIZE} nodes, majority: ${MAJORITY}`
  );
}

// ── Leader Election ───────────────────────────────────────────────────────────

/**
 * Fired when the election timeout expires without receiving a heartbeat.
 * Converts this node to Candidate and sends RequestVote RPCs to all peers.
 */
async function startElection() {
  if (state === 'Leader') return; // Safety guard
  if (electionInProgress) return; // Prevent re-entrant elections

  electionInProgress = true;
  becomeCandidate();

  let votes       = 1; // Self-vote already recorded in becomeCandidate()
  let steppedDown = false;

  console.log(`[RAFT][${config.REPLICA_ID}] Requesting votes from ${config.PEERS.length} peer(s)...`);

  const voteRequests = config.PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/request-vote`, {
        term:         currentTerm,
        candidateId:  config.REPLICA_ID,
        lastLogIndex: log.lastIndex(),
        lastLogTerm:  log.lastTerm(),
      }, { timeout: config.RPC_TIMEOUT_MS });

      if (res.data.term > currentTerm) {
        // Discovered a higher term — revert immediately
        console.log(`[RAFT][${config.REPLICA_ID}] Higher term (${res.data.term}) from ${peer} — stepping down`);
        becomeFollower(res.data.term);
        steppedDown = true;
        return;
      }

      if (res.data.voteGranted) {
        votes += 1;
        console.log(`[RAFT][${config.REPLICA_ID}] Vote granted by ${peer} (total: ${votes})`);
      } else {
        console.log(`[RAFT][${config.REPLICA_ID}] Vote denied  by ${peer}`);
      }
    } catch {
      console.warn(`[RAFT][${config.REPLICA_ID}] RequestVote → ${peer} unreachable / timed out`);
    }
  });

  await Promise.allSettled(voteRequests);
  electionInProgress = false;

  // Re-check — could have stepped down during RPC round-trips
  if (steppedDown || state !== 'Candidate') return;

  if (votes >= MAJORITY) {
    becomeLeader();
  } else {
    // Split vote — revert; random election timeout will trigger another attempt
    console.log(
      `[RAFT][${config.REPLICA_ID}] Election failed — votes: ${votes}/${MAJORITY} needed. Retrying after next timeout.`
    );
    becomeFollower(currentTerm);
  }
}

// ── Heartbeat Sender (Leader → Followers) ─────────────────────────────────────

/**
 * Broadcasts heartbeats to all peers to suppress their election timers.
 * Also detects any node with a higher term and steps down immediately.
 */
async function sendHeartbeats() {
  if (state !== 'Leader') return;

  for (const peer of config.PEERS) {
    try {
      const res = await axios.post(`${peer}/heartbeat`, {
        term:         currentTerm,
        leaderId:     config.REPLICA_ID,
        leaderCommit: commitIndex,
      }, { timeout: config.RPC_TIMEOUT_MS });

      if (res.data.term > currentTerm) {
        console.log(`[RAFT][${config.REPLICA_ID}] Higher term (${res.data.term}) in heartbeat reply from ${peer} — stepping down`);
        becomeFollower(res.data.term);
        return; // Stop sending once we've stepped down
      }
    } catch {
      // Peer unreachable — it will eventually time out and start an election itself
    }
  }
}

// ── RPC Handlers (invoked by server.js routes) ────────────────────────────────

/**
 * POST /request-vote
 * Grants a vote if:
 *  1. Candidate's term >= our currentTerm
 *  2. We haven't voted yet this term (or voted for this same candidate)
 *  3. Candidate's log is at least as up-to-date as ours (RAFT §5.4):
 *     - candidate's lastLogTerm  > our lastTerm, OR
 *     - same lastLogTerm AND candidate's lastLogIndex >= our lastIndex
 */
function handleRequestVote(body) {
  const { term, candidateId, lastLogIndex, lastLogTerm } = body;

  // Step down if we see a higher term
  if (term > currentTerm) {
    becomeFollower(term);
  }

  // Log up-to-date check (RAFT §5.4)
  const logUpToDate =
    lastLogTerm > log.lastTerm() ||
    (lastLogTerm === log.lastTerm() && lastLogIndex >= log.lastIndex());

  const voteGranted =
    term >= currentTerm &&
    (votedFor === null || votedFor === candidateId) &&
    logUpToDate;

  if (voteGranted) {
    votedFor = candidateId;
    resetElectionTimer(); // Valid candidate — reset our timer
    console.log(`[RAFT][${config.REPLICA_ID}] ✓ Voted for ${candidateId} in term ${term}`);
  } else {
    console.log(
      `[RAFT][${config.REPLICA_ID}] ✗ Denied vote for ${candidateId} in term ${term}` +
      ` (votedFor=${votedFor}, logUpToDate=${logUpToDate})`
    );
  }

  return { term: currentTerm, voteGranted };
}

/**
 * POST /heartbeat
 * - Rejects stale heartbeats (term < currentTerm)
 * - Steps down if term > currentTerm or if we are a Candidate and a leader appeared
 * - Advances commitIndex if leaderCommit > ours
 */
function handleHeartbeat(body) {
  const { term, leaderId, leaderCommit } = body;

  // Reject stale leader
  if (term < currentTerm) {
    return { term: currentTerm, success: false };
  }

  if (term > currentTerm) {
    becomeFollower(term);
  } else if (state === 'Candidate') {
    // A valid leader emerged during our election — give up candidacy
    becomeFollower(term);
  }

  currentLeader = leaderId;
  resetElectionTimer(); // Leader is alive — suppress our election timer

  // Advance commitIndex based on leader's committed knowledge
  if (leaderCommit > commitIndex) {
    const newCommit = Math.min(leaderCommit, log.lastIndex());
    for (let i = commitIndex + 1; i <= newCommit; i++) {
      log.commit(i);
    }
    commitIndex = newCommit;
    console.log(`[RAFT][${config.REPLICA_ID}] commitIndex → ${commitIndex} (via heartbeat from ${leaderId})`);
  }

  return { term: currentTerm, success: true };
}

/**
 * POST /append-entries
 * Full RAFT AppendEntries RPC handler:
 *  1. Reject stale term
 *  2. Update state on valid term / suppress candidacy
 *  3. Log consistency check (prevLogIndex / prevLogTerm)
 *  4. Truncate conflicting uncommitted entries if needed
 *  5. Append the new entry (idempotent if already present)
 *  6. Advance commitIndex to match leader
 */
function handleAppendEntries(body) {
  const { term, leaderId, prevLogIndex, prevLogTerm, entry, leaderCommit } = body;

  // 1. Reject stale RPCs
  if (term < currentTerm) {
    return { term: currentTerm, success: false };
  }

  // 2. Update state
  if (term > currentTerm) {
    becomeFollower(term);
  } else if (state === 'Candidate') {
    becomeFollower(term); // Valid leader asserted — step down from candidacy
  }

  currentLeader = leaderId;
  resetElectionTimer();

  // 3. Log consistency check
  if (prevLogIndex > 0) {
    const prevEntry = log.getEntry(prevLogIndex);

    if (!prevEntry) {
      // We don't have the expected previous entry — we're behind
      console.log(
        `[RAFT][${config.REPLICA_ID}] Missing prevLogIndex=${prevLogIndex}` +
        ` — need sync (our logLength=${log.length})`
      );
      return { term: currentTerm, success: false, logLength: log.length };
    }

    if (prevEntry.term !== prevLogTerm) {
      // Log divergence — let leader trigger sync-log
      console.log(
        `[RAFT][${config.REPLICA_ID}] Log conflict at index=${prevLogIndex}:` +
        ` expected term ${prevLogTerm}, got ${prevEntry.term}`
      );
      return { term: currentTerm, success: false, logLength: log.length };
    }
  }

  // 4 & 5. Append entry (with conflict handling)
  if (entry) {
    const existing = log.getEntry(entry.index);
    if (existing) {
      if (existing.term !== entry.term) {
        // Conflict: truncate from this index onward (never removes committed entries)
        log.truncateFrom(entry.index);
        log.append(entry.term, entry.stroke);
        console.log(`[RAFT][${config.REPLICA_ID}] Conflict at index=${entry.index} — truncated and re-appended`);
      }
      // else: identical entry already present — idempotent, no-op
    } else {
      log.append(entry.term, entry.stroke);
      console.log(`[RAFT][${config.REPLICA_ID}] Appended entry index=${entry.index}, term=${entry.term}`);
    }
  }

  // 6. Advance commitIndex
  if (leaderCommit > commitIndex) {
    const newCommit = Math.min(leaderCommit, log.lastIndex());
    for (let i = commitIndex + 1; i <= newCommit; i++) {
      log.commit(i);
    }
    commitIndex = newCommit;
    console.log(`[RAFT][${config.REPLICA_ID}] commitIndex → ${commitIndex} (via AppendEntries from ${leaderId})`);
  }

  return { term: currentTerm, success: true };
}

/**
 * POST /sync-log
 * Bulk catch-up: leader sends all committed entries the follower is missing.
 * Triggered by the leader after a follower rejects AppendEntries with logLength mismatch.
 */
function handleSyncLog(body) {
  const { term, leaderId, entries, leaderCommit } = body;

  if (term < currentTerm) {
    return { success: false, term: currentTerm };
  }

  if (term > currentTerm) {
    becomeFollower(term);
  }

  currentLeader = leaderId;
  resetElectionTimer();

  console.log(`[RAFT][${config.REPLICA_ID}] /sync-log: received ${entries.length} entries from ${leaderId}`);

  for (const e of entries) {
    const existing = log.getEntry(e.index);
    if (!existing) {
      log.append(e.term, e.stroke);
      console.log(`[RAFT][${config.REPLICA_ID}]   sync-append  index=${e.index}, term=${e.term}`);
    } else if (existing.term !== e.term) {
      log.truncateFrom(e.index);
      log.append(e.term, e.stroke);
      console.log(`[RAFT][${config.REPLICA_ID}]   sync-replace index=${e.index} (term mismatch)`);
    }
    // else: exact match already present — idempotent
  }

  // Advance commitIndex after bulk append
  if (leaderCommit > commitIndex) {
    const newCommit = Math.min(leaderCommit, log.lastIndex());
    for (let i = commitIndex + 1; i <= newCommit; i++) {
      log.commit(i);
    }
    commitIndex = newCommit;
    console.log(`[RAFT][${config.REPLICA_ID}] Post-sync commitIndex → ${commitIndex}`);
  }

  return { success: true, logLength: log.length };
}

// ── Client Stroke Pipeline (Leader only) ──────────────────────────────────────

/**
 * POST /client-stroke
 * Full replication pipeline (RAFT §5.3):
 *  1. Reject if not Leader
 *  2. Append stroke to local log
 *  3. Send AppendEntries to all peers in parallel
 *     - Peer rejects with logLength mismatch → fire-and-forget triggerSyncLog
 *     - Peer replies higher term → step down
 *  4. Commit if majority (self + peers) ACKed
 *  5. Notify Gateway via POST /broadcast
 */
async function handleClientStroke(stroke) {
  if (state !== 'Leader') {
    return { success: false, error: 'not leader', leader: currentLeader };
  }

  // Step 1: Append to local log
  const entry        = log.append(currentTerm, stroke);
  const prevLogIndex = entry.index - 1;
  const prevLogTerm  = prevLogIndex > 0 ? (log.getEntry(prevLogIndex)?.term ?? 0) : 0;

  console.log(
    `[RAFT][${config.REPLICA_ID}] Stroke received → appended index=${entry.index}, term=${currentTerm}`
  );

  // Step 2: Replicate to all peers in parallel
  let acks        = 1; // Leader's own append counts as an ACK
  let steppedDown = false;

  await Promise.allSettled(
    config.PEERS.map(async (peer) => {
      try {
        const res = await axios.post(`${peer}/append-entries`, {
          term:         currentTerm,
          leaderId:     config.REPLICA_ID,
          prevLogIndex,
          prevLogTerm,
          entry: {
            index:  entry.index,
            term:   entry.term,
            stroke: entry.stroke,
          },
          leaderCommit: commitIndex,
        }, { timeout: config.RPC_TIMEOUT_MS });

        if (res.data.term > currentTerm) {
          // Higher term — must step down
          console.log(
            `[RAFT][${config.REPLICA_ID}] Higher term (${res.data.term}) from ${peer} during replication — stepping down`
          );
          becomeFollower(res.data.term);
          steppedDown = true;
          return;
        }

        if (res.data.success) {
          acks += 1;
          console.log(`[RAFT][${config.REPLICA_ID}] ACK from ${peer} for index=${entry.index} (acks: ${acks})`);
        } else {
          // Follower's log is behind — trigger sync (non-blocking, best-effort)
          const followerLen = res.data.logLength ?? 0;
          console.warn(
            `[RAFT][${config.REPLICA_ID}] ${peer} rejected AppendEntries (logLength=${followerLen}) — triggering /sync-log`
          );
          triggerSyncLog(peer, followerLen).catch(() => {});
        }
      } catch {
        console.warn(`[RAFT][${config.REPLICA_ID}] AppendEntries → ${peer} unreachable / timed out`);
      }
    })
  );

  // If we stepped down during replication, do not commit
  if (steppedDown || state !== 'Leader') {
    return { success: false, error: 'leadership lost during replication' };
  }

  // Step 3: Commit on majority
  if (acks >= MAJORITY) {
    commitIndex = entry.index;
    log.commit(entry.index);
    console.log(
      `[RAFT][${config.REPLICA_ID}] ✓ Committed index=${entry.index} (acks: ${acks}/${CLUSTER_SIZE})`
    );

    // Step 4: Notify Gateway → broadcasts committed stroke to all WS clients
    await notifyGateway(entry);

    return { success: true, index: entry.index };
  }

  // No quorum — entry sits uncommitted (will be resolved on sync/catch-up)
  console.warn(
    `[RAFT][${config.REPLICA_ID}] ✗ No quorum for index=${entry.index}` +
    ` — acks: ${acks}/${MAJORITY} needed`
  );
  return { success: false, error: 'no quorum', acks };
}

// ── Sync-Log Trigger (Leader → Lagging Follower) ─────────────────────────────

/**
 * Leader sends all entries from (followerLogLength + 1) onward to the lagging peer.
 * Called non-blocking when a follower rejects AppendEntries due to log being behind.
 */
async function triggerSyncLog(peer, followerLogLength) {
  const missingEntries = log.getFrom(followerLogLength + 1);
  if (missingEntries.length === 0) return;

  console.log(
    `[RAFT][${config.REPLICA_ID}] Sending ${missingEntries.length} missing entries to ${peer} via /sync-log`
  );

  try {
    await axios.post(`${peer}/sync-log`, {
      term:         currentTerm,
      leaderId:     config.REPLICA_ID,
      entries:      missingEntries.map(e => ({ index: e.index, term: e.term, stroke: e.stroke })),
      leaderCommit: commitIndex,
    }, { timeout: config.RPC_TIMEOUT_MS * 5 }); // Generous timeout for bulk transfers
  } catch (err) {
    console.warn(`[RAFT][${config.REPLICA_ID}] /sync-log to ${peer} failed: ${err.message}`);
  }
}

// ── Gateway Notification ──────────────────────────────────────────────────────

/**
 * After committing an entry, the Leader POSTs /broadcast to the Gateway.
 * The Gateway then pushes the stroke to all connected WebSocket clients.
 */
async function notifyGateway(entry) {
  try {
    await axios.post(`${config.GATEWAY_URL}/broadcast`, {
      stroke: {
        index: entry.index,
        ...entry.stroke,
      },
    }, { timeout: 1000 });
    console.log(`[RAFT][${config.REPLICA_ID}] Gateway notified — broadcast index=${entry.index}`);
  } catch (err) {
    console.warn(
      `[RAFT][${config.REPLICA_ID}] Gateway notify failed (index=${entry.index}): ${err.message}`
    );
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function start() {
  console.log(`[RAFT][${config.REPLICA_ID}] ── Mini-RAFT node starting ──────────────────────`);
  console.log(`[RAFT][${config.REPLICA_ID}]    Peers       : ${config.PEERS.join(', ') || '(none)'}`);
  console.log(`[RAFT][${config.REPLICA_ID}]    Cluster size: ${CLUSTER_SIZE}`);
  console.log(`[RAFT][${config.REPLICA_ID}]    Majority    : ${MAJORITY}`);
  console.log(`[RAFT][${config.REPLICA_ID}]    Election TO : ${config.ELECTION_TIMEOUT_MIN_MS}–${config.ELECTION_TIMEOUT_MAX_MS} ms`);
  console.log(`[RAFT][${config.REPLICA_ID}]    Heartbeat   : every ${config.HEARTBEAT_INTERVAL_MS} ms`);
  console.log(`[RAFT][${config.REPLICA_ID}] ──────────────────────────────────────────────────`);

  // Add a small startup jitter based on the replica ID digit so all three nodes
  // don't fire their first election at exactly the same moment on Docker startup.
  // replica1 → +0 ms, replica2 → +50 ms, replica3 → +100 ms (well within timeout window)
  const idDigit   = parseInt(config.REPLICA_ID.replace(/\D/g, ''), 10) || 1;
  const jitter    = (idDigit - 1) * 50;
  console.log(`[RAFT][${config.REPLICA_ID}] Applying startup jitter: ${jitter} ms`);
  setTimeout(() => becomeFollower(0), jitter);
}

/**
 * Returns the current observable RAFT state.
 * Shape matches SRS §6.1 GET /status spec exactly:
 * { id, state, term, leader, logLength, commitIndex }
 */
function getStatus() {
  return {
    id:          config.REPLICA_ID,
    state,
    term:        currentTerm,
    leader:      currentLeader,
    logLength:   log.length,
    commitIndex,
  };
}

module.exports = {
  start,
  getStatus,
  handleRequestVote,
  handleHeartbeat,
  handleAppendEntries,
  handleSyncLog,
  handleClientStroke,
};
