'use strict';

/**
 * Mini-RAFT Node
 *
 * Implements the core RAFT consensus concepts:
 *  - Leader election via randomized election timeouts
 *  - Log replication of drawing strokes across peer nodes
 *  - Heartbeat-based lease renewal
 *
 * Inter-node RPC is performed over plain HTTP (POST requests) using axios.
 * Each entry in `this.log` is a drawing-stroke object that gets committed once
 * a majority of nodes acknowledge it.
 */

const EventEmitter = require('events');
const axios = require('axios');

const States = Object.freeze({
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader',
});

// Timing constants (milliseconds)
const ELECTION_TIMEOUT_MIN = 3000;
const ELECTION_TIMEOUT_MAX = 6000;
const HEARTBEAT_INTERVAL = 1000;

class RaftNode extends EventEmitter {
  /**
   * @param {string|number} id        Unique node identifier
   * @param {string[]}      peerUrls  HTTP base URLs of peer nodes, e.g. ['http://localhost:3001']
   */
  constructor(id, peerUrls = []) {
    super();

    this.id = id;
    this.peerUrls = peerUrls; // URLs of the other RAFT nodes

    // Persistent state
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = []; // Array of { term, index, stroke }

    // Volatile state
    this.commitIndex = -1;
    this.lastApplied = -1;
    this.state = States.FOLLOWER;
    this.leaderId = null;
    this.leaderUrl = null;
    this.votes = 0;

    // Leader-only volatile state
    this.nextIndex = {}; // peerUrl -> next log index to send
    this.matchIndex = {}; // peerUrl -> highest log index known replicated

    this.electionTimer = null;
    this.heartbeatTimer = null;

    this._resetElectionTimer();
  }

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  getState() {
    return {
      id: this.id,
      state: this.state,
      term: this.currentTerm,
      leaderId: this.leaderId,
      logLength: this.log.length,
      commitIndex: this.commitIndex,
    };
  }

  isLeader() {
    return this.state === States.LEADER;
  }

  /**
   * Append a new drawing stroke to the log (leader only).
   * Replicates to all peers and commits once a majority ACK.
   * @param {object} stroke
   * @returns {Promise<boolean>} true if committed
   */
  async appendStroke(stroke) {
    if (!this.isLeader()) {
      return false;
    }

    const entry = {
      term: this.currentTerm,
      index: this.log.length,
      stroke,
    };
    this.log.push(entry);

    // Immediately apply optimistically on the leader so the drawing
    // originator sees the stroke without waiting for peer consensus.
    this._maybeApply();

    await this._replicateToAll();
    return true;
  }

  // ---------------------------------------------------------------------------
  // RAFT RPC handlers  (called by the HTTP layer in server.js)
  // ---------------------------------------------------------------------------

  /**
   * RequestVote RPC handler.
   * @param {{ term, candidateId, lastLogIndex, lastLogTerm }} req
   * @returns {{ term, voteGranted }}
   */
  handleRequestVote({ term, candidateId, lastLogIndex, lastLogTerm }) {
    if (term > this.currentTerm) {
      this._becomeFollower(term);
    }

    const myLastLogIndex = this.log.length - 1;
    const myLastLogTerm = myLastLogIndex >= 0 ? this.log[myLastLogIndex].term : -1;

    const logOk =
      lastLogTerm > myLastLogTerm ||
      (lastLogTerm === myLastLogTerm && lastLogIndex >= myLastLogIndex);

    const voteGranted =
      term >= this.currentTerm &&
      (this.votedFor === null || this.votedFor === candidateId) &&
      logOk;

    if (voteGranted) {
      this.votedFor = candidateId;
      this._resetElectionTimer();
    }

    return { term: this.currentTerm, voteGranted };
  }

  /**
   * AppendEntries RPC handler (also serves as heartbeat).
   * @param {{ term, leaderId, leaderUrl, prevLogIndex, prevLogTerm, entries, leaderCommit }} req
   * @returns {{ term, success }}
   */
  handleAppendEntries({
    term,
    leaderId,
    leaderUrl,
    prevLogIndex,
    prevLogTerm,
    entries = [],
    leaderCommit,
  }) {
    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    // Valid leader – reset election timer
    this._becomeFollower(term);
    this.leaderId = leaderId;
    // Only accept leaderUrl values from the known peer set to prevent SSRF
    if (leaderUrl && this.peerUrls.includes(leaderUrl)) {
      this.leaderUrl = leaderUrl;
    }
    this._resetElectionTimer();

    // Check log consistency
    if (prevLogIndex >= 0) {
      if (this.log.length <= prevLogIndex) {
        return { term: this.currentTerm, success: false };
      }
      if (this.log[prevLogIndex].term !== prevLogTerm) {
        // Remove conflicting entries
        this.log.splice(prevLogIndex);
        return { term: this.currentTerm, success: false };
      }
    }

    // Append new entries (skip existing ones that match)
    for (const entry of entries) {
      if (this.log.length > entry.index) {
        if (this.log[entry.index].term !== entry.term) {
          this.log.splice(entry.index);
          this.log.push(entry);
        }
        // else: already have this entry, skip
      } else {
        this.log.push(entry);
      }
    }

    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      this._maybeApply();
    }

    return { term: this.currentTerm, success: true };
  }

  // ---------------------------------------------------------------------------
  // Private: election
  // ---------------------------------------------------------------------------

  _resetElectionTimer() {
    clearTimeout(this.electionTimer);
    const timeout =
      ELECTION_TIMEOUT_MIN +
      Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX - ELECTION_TIMEOUT_MIN));
    this.electionTimer = setTimeout(() => this._startElection(), timeout);
  }

  async _startElection() {
    this.state = States.CANDIDATE;
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.votes = 1; // vote for self
    this.leaderId = null;
    this.emit('stateChange', this.getState());

    if (this.peerUrls.length === 0) {
      // Single-node cluster – become leader immediately
      this._becomeLeader();
      return;
    }

    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : -1;
    const majority = Math.floor((this.peerUrls.length + 1) / 2) + 1;

    const voteRequests = this.peerUrls.map((url) =>
      axios
        .post(
          `${url}/raft/requestVote`,
          {
            term: this.currentTerm,
            candidateId: this.id,
            lastLogIndex,
            lastLogTerm,
          },
          { timeout: 1000 }
        )
        .then(({ data }) => data)
        .catch(() => ({ voteGranted: false }))
    );

    const results = await Promise.all(voteRequests);
    for (const result of results) {
      if (result.term > this.currentTerm) {
        this._becomeFollower(result.term);
        return;
      }
      if (result.voteGranted) {
        this.votes += 1;
      }
    }

    if (this.state === States.CANDIDATE && this.votes >= majority) {
      this._becomeLeader();
    } else {
      this._becomeFollower(this.currentTerm);
    }
  }

  _becomeLeader() {
    this.state = States.LEADER;
    this.leaderId = this.id;
    this.leaderUrl = null; // set by server.js after construction
    this.votes = 0;

    // Initialize leader tracking state
    for (const url of this.peerUrls) {
      this.nextIndex[url] = this.log.length;
      this.matchIndex[url] = -1;
    }

    clearTimeout(this.electionTimer);
    this._sendHeartbeats();
    this.heartbeatTimer = setInterval(
      () => this._sendHeartbeats(),
      HEARTBEAT_INTERVAL
    );

    this.emit('stateChange', this.getState());
    this.emit('leaderElected', this.getState());
  }

  _becomeFollower(term) {
    const wasLeader = this.state === States.LEADER;
    this.state = States.FOLLOWER;
    this.currentTerm = term;
    this.votedFor = null;
    this.votes = 0;

    if (wasLeader) {
      clearInterval(this.heartbeatTimer);
    }
    this.emit('stateChange', this.getState());
  }

  // ---------------------------------------------------------------------------
  // Private: replication
  // ---------------------------------------------------------------------------

  async _sendHeartbeats() {
    await this._replicateToAll();
  }

  async _replicateToAll() {
    if (!this.isLeader()) return;

    const replications = this.peerUrls.map((url) =>
      this._replicateToPeer(url)
    );
    await Promise.allSettled(replications);
    this._advanceCommitIndex();
  }

  async _replicateToPeer(peerUrl) {
    const ni = this.nextIndex[peerUrl] ?? this.log.length;
    const prevLogIndex = ni - 1;
    const prevLogTerm = prevLogIndex >= 0 ? this.log[prevLogIndex]?.term ?? -1 : -1;
    const entries = this.log.slice(ni);

    try {
      const { data } = await axios.post(
        `${peerUrl}/raft/appendEntries`,
        {
          term: this.currentTerm,
          leaderId: this.id,
          leaderUrl: this.leaderUrl,
          prevLogIndex,
          prevLogTerm,
          entries,
          leaderCommit: this.commitIndex,
        },
        { timeout: 1000 }
      );

      if (data.term > this.currentTerm) {
        this._becomeFollower(data.term);
        return;
      }

      if (data.success) {
        this.matchIndex[peerUrl] = prevLogIndex + entries.length;
        this.nextIndex[peerUrl] = this.matchIndex[peerUrl] + 1;
      } else {
        // Decrement and retry on next heartbeat
        this.nextIndex[peerUrl] = Math.max(0, ni - 1);
      }
    } catch {
      // Peer unreachable – will retry on next heartbeat
    }
  }

  _advanceCommitIndex() {
    // Find the highest N such that a majority has matchIndex >= N and log[N].term == currentTerm
    for (let n = this.log.length - 1; n > this.commitIndex; n--) {
      if (this.log[n].term !== this.currentTerm) continue;

      const replicatedCount =
        1 + // leader itself
        Object.values(this.matchIndex).filter((mi) => mi >= n).length;

      const majority = Math.floor((this.peerUrls.length + 1) / 2) + 1;
      if (replicatedCount >= majority) {
        this.commitIndex = n;
        this._maybeApply();
        break;
      }
    }
  }

  _maybeApply() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.log[this.lastApplied];
      // Emit committed stroke so server.js can broadcast it to browser clients
      this.emit('committed', entry.stroke, entry.index);
    }
  }

  // ---------------------------------------------------------------------------
  // Clean-up
  // ---------------------------------------------------------------------------

  stop() {
    clearTimeout(this.electionTimer);
    clearInterval(this.heartbeatTimer);
  }
}

module.exports = { RaftNode, States };
