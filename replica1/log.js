/**
 * log.js — Append-Only Stroke Log
 *
 * Responsibilities:
 *  - Maintain an in-memory append-only array of log entries
 *  - Each entry: { index, term, stroke, committed }
 *  - Provide helpers: append, getEntry, lastIndex, lastTerm, getFrom, commit
 *
 * Safety Rules (from RAFT spec):
 *  - Committed entries are NEVER overwritten
 *  - Log index is 1-based
 *
 * TODO (Week 2): Implement all methods below
 */

class StrokeLog {
  constructor() {
    /** @type {Array<{ index: number, term: number, stroke: object, committed: boolean }>} */
    this.entries = [];
  }

  /** Append a new entry to the log. Returns the new entry. */
  append(term, stroke) {
    const entry = {
      index:     this.entries.length + 1,
      term,
      stroke,
      committed: false,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Get entry by 1-based index. Returns undefined if not found. */
  getEntry(index) {
    return this.entries[index - 1];
  }

  /** Return the index of the last entry (0 if log is empty). */
  lastIndex() {
    return this.entries.length;
  }

  /** Return the term of the last entry (0 if log is empty). */
  lastTerm() {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1].term
      : 0;
  }

  /**
   * Return all entries from startIndex (1-based) onward.
   * Used by /sync-log to send missing entries to a restarted follower.
   */
  getFrom(startIndex) {
    return this.entries.slice(startIndex - 1);
  }

  /** Mark an entry as committed by its 1-based index. */
  commit(index) {
    const entry = this.getEntry(index);
    if (entry) {
      entry.committed = true;
    }
  }

  /** Return all committed entries (for full-sync to Gateway/clients). */
  getCommitted() {
    return this.entries.filter(e => e.committed);
  }

  /** Return the current length of the log. */
  get length() {
    return this.entries.length;
  }
}

module.exports = new StrokeLog();
