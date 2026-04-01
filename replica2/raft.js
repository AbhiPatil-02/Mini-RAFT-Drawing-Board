/**
 * raft.js — Mini-RAFT State Machine
 *
 * States: Follower | Candidate | Leader
 *
 * Responsibilities:
 *  - Manage currentTerm, votedFor, state, commitIndex
 *  - Implement leader election (RequestVote RPC)
 *  - Implement heartbeat sender (Leader) and receiver (Follower)
 *  - Implement log replication (AppendEntries RPC)
 *  - Implement catch-up sync (/sync-log)
 *  - Notify Gateway on commit
 *
 * TODO (Week 2):
 *  - Implement becomeFollower(), becomeCandidate(), becomeLeader()
 *  - Implement startElectionTimer() with random timeout (500–800 ms)
 *  - Implement sendHeartbeats() every 150 ms
 *  - Implement handleRequestVote(body) — vote granting logic
 *  - Implement handleAppendEntries(body) — log consistency check + append
 *  - Implement handleHeartbeat(body) — reset timer, update term
 *  - Implement handleClientStroke(stroke) — leader appends + replicates
 *
 * TODO (Week 3):
 *  - Implement handleSyncLog(body) — append all missing entries
 *  - Implement triggerSyncLog(peer, fromIndex) — send entries to lagging follower
 *  - Implement notifyGateway(stroke) — POST /broadcast to Gateway
 */

const axios  = require('axios');
const config = require('./config');
const log    = require('./log');

// ── State ─────────────────────────────────────────────────────────────────────
let state        = 'Follower';   // 'Follower' | 'Candidate' | 'Leader'
let currentTerm  = 0;
let votedFor     = null;         // replicaId string or null
let commitIndex  = 0;
let currentLeader = null;

let electionTimer   = null;
let heartbeatTimer  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── State Transitions ─────────────────────────────────────────────────────────

function becomeFollower(term) {
  console.log(`[RAFT][${config.REPLICA_ID}] → FOLLOWER (term ${term})`);
  state        = 'Follower';
  currentTerm  = term;
  votedFor     = null;
  clearInterval(heartbeatTimer);
  resetElectionTimer();
}

function becomeLeader() {
  console.log(`[RAFT][${config.REPLICA_ID}] → LEADER (term ${currentTerm})`);
  state         = 'Leader';
  currentLeader = config.REPLICA_ID;
  clearTimeout(electionTimer);
  // TODO (Week 2): Start sending heartbeats every HEARTBEAT_INTERVAL_MS
  heartbeatTimer = setInterval(sendHeartbeats, config.HEARTBEAT_INTERVAL_MS);
}

// ── Election ──────────────────────────────────────────────────────────────────

async function startElection() {
  console.log(`[RAFT][${config.REPLICA_ID}] Starting election — term ${currentTerm + 1}`);
  state = 'Candidate';
  currentTerm += 1;
  votedFor = config.REPLICA_ID;
  let votes = 1; // self-vote

  const voteRequests = config.PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/request-vote`, {
        term:         currentTerm,
        candidateId:  config.REPLICA_ID,
        lastLogIndex: log.lastIndex(),
        lastLogTerm:  log.lastTerm(),
      }, { timeout: config.RPC_TIMEOUT_MS });

      if (res.data.term > currentTerm) {
        becomeFollower(res.data.term);
        return;
      }
      if (res.data.voteGranted) {
        votes += 1;
        console.log(`[RAFT][${config.REPLICA_ID}] Vote received from ${peer}. Total: ${votes}`);
      }
    } catch {
      // Peer unreachable — skip
    }
  });

  await Promise.allSettled(voteRequests);

  if (state !== 'Candidate') return; // stepped down during requests

  if (votes >= 2) {
    becomeLeader();
  } else {
    console.log(`[RAFT][${config.REPLICA_ID}] Election failed (split vote) — retrying`);
    becomeFollower(currentTerm);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function sendHeartbeats() {
  // TODO (Week 2): POST /heartbeat to all peers
  for (const peer of config.PEERS) {
    try {
      await axios.post(`${peer}/heartbeat`, {
        term:         currentTerm,
        leaderId:     config.REPLICA_ID,
        leaderCommit: commitIndex,
      }, { timeout: config.RPC_TIMEOUT_MS });
    } catch {
      // Peer unreachable — skip
    }
  }
}

// ── RPC Handlers (called by server.js routes) ─────────────────────────────────

function handleRequestVote(body) {
  const { term, candidateId, lastLogIndex, lastLogTerm } = body;

  if (term > currentTerm) becomeFollower(term);

  const voteGranted =
    term >= currentTerm &&
    (votedFor === null || votedFor === candidateId) &&
    lastLogIndex >= log.lastIndex();

  if (voteGranted) {
    votedFor = candidateId;
    resetElectionTimer();
    console.log(`[RAFT][${config.REPLICA_ID}] Voted for ${candidateId} (term ${term})`);
  }

  return { term: currentTerm, voteGranted };
}

function handleHeartbeat(body) {
  const { term, leaderId, leaderCommit } = body;

  if (term < currentTerm) return { term: currentTerm, success: false };

  if (term > currentTerm) becomeFollower(term);
  currentLeader = leaderId;
  resetElectionTimer();

  // TODO (Week 2): Update commitIndex if leaderCommit > commitIndex
  return { term: currentTerm, success: true };
}

function handleAppendEntries(body) {
  const { term, leaderId, prevLogIndex, prevLogTerm, entry, leaderCommit } = body;

  if (term < currentTerm) return { term: currentTerm, success: false };

  if (term > currentTerm) becomeFollower(term);
  currentLeader = leaderId;
  resetElectionTimer();

  // Consistency check
  if (prevLogIndex > 0) {
    const prev = log.getEntry(prevLogIndex);
    if (!prev || prev.term !== prevLogTerm) {
      return { term: currentTerm, success: false, logLength: log.length };
    }
  }

  // TODO (Week 2): Append entry to local log
  // log.append(entry.term, entry.stroke);

  return { term: currentTerm, success: true };
}

function handleSyncLog(body) {
  const { entries, leaderCommit } = body;
  // TODO (Week 3): Append all missing entries and update commitIndex
  console.log(`[RAFT][${config.REPLICA_ID}] /sync-log received ${entries.length} entries`);
  return { success: true, logLength: log.length };
}

async function handleClientStroke(stroke) {
  if (state !== 'Leader') return { success: false, error: 'not leader' };

  // TODO (Week 2): Append stroke, replicate to peers, commit on majority
  const entry = log.append(currentTerm, stroke);
  console.log(`[RAFT][${config.REPLICA_ID}] Stroke appended at index ${entry.index}`);

  return { success: true, index: entry.index };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function start() {
  console.log(`[RAFT][${config.REPLICA_ID}] Starting as Follower (term 0)`);
  becomeFollower(0);
}

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
