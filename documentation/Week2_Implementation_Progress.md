# Week 2 Implementation Progress

**Project:** Mini-RAFT Drawing Board  
**Phase:** Week 2 — Core RAFT State Machine + Gateway + Frontend  
**Session Date:** 2026-04-02  
**Status:** ✅ Complete — All 5 containers running, leader elected on startup

---

## Overview

This document records every file created or modified during the Week 2 implementation session. It serves as a handoff reference for Week 3 continuation and for understanding the system's current state.

### What Was Built

| Component | Files Changed | Outcome |
|---|---|---|
| RAFT State Machine | `replica{1,2,3}/raft.js` | Full election + replication pipeline |
| Stroke Log | `replica{1,2,3}/log.js` | Added `truncateFrom()` for RAFT safety |
| Replica HTTP Server | `replica{1,2,3}/server.js` | Added `GET /committed-log` endpoint |
| Gateway WebSocket | `gateway/server.js` | Full WS client management + broadcast |
| Leader Tracker | `gateway/leaderTracker.js` | Discovery + queue + replay |
| Frontend Canvas | `frontend/app.js` | Freehand drawing + WS client |
| Frontend HTML | `frontend/index.html` | Full toolbar UI layout |
| Frontend CSS | `frontend/style.css` | Dark glassmorphism design |
| Dockerfiles | `replica{1,2,3}/Dockerfile` | Fixed EXPOSE ports + CMD |

---

## 1. `replica1/log.js` — Stroke Log

**Added:** `truncateFrom(startIndex)`

### Why it was needed
RAFT safety requires that when a follower detects a log conflict with the leader, it must delete all uncommitted entries from the conflict point onward before appending the leader's version. Without this method `handleAppendEntries` had no way to enforce log consistency.

### How it works
```js
truncateFrom(startIndex) {
  const lastCommitted = this.entries.reduce((max, e) =>
    e.committed ? Math.max(max, e.index) : max, 0);
  const safeStart = Math.max(startIndex, lastCommitted + 1);
  if (safeStart <= this.entries.length) {
    this.entries = this.entries.slice(0, safeStart - 1);
  }
}
```
- Finds the highest committed index — those entries are **never removable**
- Only truncates uncommitted entries at or after `startIndex`

**Also fixed:** `getFrom(startIndex)` now guards `startIndex < 1` to return all entries safely.

**Synced to:** `replica2/log.js`, `replica3/log.js` (md5 verified identical)

---

## 2. `replica1/raft.js` — Mini-RAFT State Machine (596 lines)

The core of Week 2. Every function is fully implemented to RAFT spec.

### State Variables
```js
let state         = 'Follower'; // 'Follower' | 'Candidate' | 'Leader'
let currentTerm   = 0;
let votedFor      = null;
let commitIndex   = 0;
let currentLeader = null;
let electionInProgress = false; // Re-entrant election guard (added later)
```

### Cluster Constants
```js
const CLUSTER_SIZE = config.PEERS.length + 1; // 3
const MAJORITY     = Math.floor(CLUSTER_SIZE / 2) + 1; // 2 of 3
```

### State Transitions

#### `becomeFollower(term)`
- Sets `state = 'Follower'`, updates `currentTerm`, clears `votedFor`
- Stops heartbeat timer (if was leader)
- Starts election countdown via `resetElectionTimer()`
- Called on: boot, higher-term RPC received, lost election, step-down

#### `becomeCandidate()`
- Sets `state = 'Candidate'`, increments `currentTerm`, self-votes (`votedFor = REPLICA_ID`)
- Stops heartbeat timer
- Called immediately before `startElection()`

#### `becomeLeader()`
- Sets `state = 'Leader'`, records `currentLeader = REPLICA_ID`
- Stops election timer (leaders don't wait for elections)
- Sends **immediate heartbeat** to assert authority
- Starts `setInterval(sendHeartbeats, 150ms)`

### Election Flow

#### `startElection()`
```
becomeCandidate()
  → POST /request-vote to all peers in parallel
  → If any peer returns higher term → becomeFollower(term), abort
  → Count votes (self-vote + granted)
  → votes >= MAJORITY → becomeLeader()
  → else → becomeFollower(currentTerm), retry after next timeout
```

**Guards added:**
- `if (state === 'Leader') return` — leaders never start elections
- `if (electionInProgress) return` — prevents re-entrant calls if election timer fires during in-flight RPCs
- `electionInProgress` flag is reset in `finally` after `Promise.allSettled`

#### `sendHeartbeats()`
- Only runs if `state === 'Leader'`
- POSTs `{ term, leaderId, leaderCommit }` to each peer
- Steps down immediately on any reply with `term > currentTerm`
- Peer timeout → skip, peer will self-elect

### RPC Handlers

#### `handleRequestVote(body)` — POST /request-vote
Full RAFT §5.4 log up-to-date check:
```js
const logUpToDate =
  lastLogTerm > log.lastTerm() ||
  (lastLogTerm === log.lastTerm() && lastLogIndex >= log.lastIndex());

const voteGranted =
  term >= currentTerm &&
  (votedFor === null || votedFor === candidateId) &&
  logUpToDate;
```
- Steps down if `term > currentTerm`
- Resets election timer on successful grant

#### `handleHeartbeat(body)` — POST /heartbeat
- Rejects stale (`term < currentTerm`)
- Steps down from Leader or Candidate if valid leader asserted
- Advances `commitIndex` from `leaderCommit` (commits entries leader has already committed)

#### `handleAppendEntries(body)` — POST /append-entries
6-step pipeline:
1. Reject stale term
2. Update state (step down from Candidate if needed)
3. **Consistency check**: verify `prevLogIndex` + `prevLogTerm` match
4. **Conflict resolution**: `truncateFrom` if entry exists with different term
5. **Idempotent append**: skip if identical entry already exists
6. **Advance commitIndex** from `leaderCommit`

Returns `{ success: false, logLength }` on failure so leader can trigger `/sync-log`

#### `handleClientStroke(stroke)` — POST /client-stroke (Leader only)
Full replication pipeline:
```
1. Reject if not Leader → { error: 'not leader', leader: currentLeader }
2. log.append(currentTerm, stroke) → entry
3. POST /append-entries to all peers in parallel
   → higher-term reply → becomeFollower, abort
   → rejected reply with logLength → triggerSyncLog(peer, followerLen) [non-blocking]
4. acks >= MAJORITY → commitIndex = entry.index, log.commit(entry.index)
5. notifyGateway(entry)
```

#### `handleSyncLog(body)` — POST /sync-log
Bulk catch-up for lagging followers:
- Leader sends all entries from `(followerLogLength + 1)` onward
- Follower does idempotent replay: skip if identical, `truncateFrom` + re-append on conflict
- Advances `commitIndex` after bulk append

### Gateway Notification
```js
async function notifyGateway(entry) {
  await axios.post(`${config.GATEWAY_URL}/broadcast`, {
    stroke: { index: entry.index, ...entry.stroke }
  }, { timeout: 1000 });
}
```

### Startup Jitter
```js
const idDigit = parseInt(config.REPLICA_ID.replace(/\D/g, ''), 10) || 1;
const jitter  = (idDigit - 1) * 50; // replica1=0ms, replica2=50ms, replica3=100ms
setTimeout(() => becomeFollower(0), jitter);
```
Prevents all 3 containers from firing elections simultaneously on Docker startup.

### `getStatus()` — GET /status
Returns `{ id, state, term, leader, logLength, commitIndex }` — matches SRS §6.1 exactly.

**Synced to:** `replica2/raft.js`, `replica3/raft.js` (md5 verified identical)

---

## 3. `replica1/server.js` — Replica HTTP Server

**Added:** `GET /committed-log` endpoint

```js
app.get('/committed-log', (req, res) => {
  const committed = log.getCommitted();
  const strokes   = committed.map(e => ({ index: e.index, ...e.stroke }));
  res.json({ strokes });
});
```

**Purpose:** Called by the Gateway's `sendFullSync()` when a new browser client connects. Returns all committed strokes so the client can reconstruct the full canvas state.

**All endpoints now available on each replica:**
| Endpoint | Method | Description |
|---|---|---|
| `/request-vote` | POST | Candidate requests vote |
| `/append-entries` | POST | Leader replicates log entry |
| `/heartbeat` | POST | Leader heartbeat |
| `/sync-log` | POST | Bulk catch-up for lagging follower |
| `/client-stroke` | POST | Gateway forwards stroke (Leader only) |
| `/status` | GET | RAFT state snapshot |
| `/committed-log` | GET | All committed strokes |

**Synced to:** `replica2/server.js`, `replica3/server.js` (md5 verified identical)

---

## 4. `gateway/server.js` — Gateway WebSocket Server (221 lines)

### Client Registry
```js
const clients = new Set(); // O(1) add/delete
let clientIdCounter = 0;   // Per-client integer ID for logging
```

### WebSocket Flow
```
ws.on('connection')
  → clients.add(ws), assign ws.id
  → sendFullSync(ws)   ← fetches /committed-log from leader

ws.on('message')
  → type: 'stroke'  → validate points[] → leaderTracker.forwardStroke()
  → type: 'ping'    → sendToClient({ type: 'pong' })
  → unknown         → sendToClient({ type: 'error', data: { message } })

ws.on('close')  → clients.delete(ws)
ws.on('error')  → clients.delete(ws)
```

### `sendFullSync(ws)`
- Calls `GET <leaderUrl>/committed-log`
- Sends `{ type: 'full-sync', data: { strokes: [...] } }` to the connecting client
- Falls back to empty sync if leader is unreachable — client can still draw

### `broadcast(payload)`
```js
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === OPEN) ws.send(msg);
  }
}
```
Safe: checks `readyState === OPEN` before every send.

### HTTP Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/broadcast` | POST | Receives committed stroke from Leader, pushes to all WS clients |
| `/health` | GET | `{ status, leader, clients }` |
| `/status` | GET | Alias for `/health` |

---

## 5. `gateway/leaderTracker.js` — Leader Discovery & Tracking (178 lines)

### Key Design Decisions

**`discoverInFlight` guard:**
```js
let discoverInFlight = false;
async function discoverLeader() {
  if (discoverInFlight) return; // Prevents concurrent discovery races
  discoverInFlight = true;
  // ...
  discoverInFlight = false;
}
```
Without this, multiple simultaneous stroke failures would spawn multiple parallel discovery loops that could race each other and corrupt `currentLeader`.

**Background polling:**
Every 2 seconds the tracker polls all replicas for the leader. This means even if the leader changes without any stroke failure (e.g. after manual kill), the gateway detects it within 2s.

**Stroke queue + replay:**
```js
const strokeQueue = [];

// On leader failure:
currentLeader = null;
strokeQueue.push(stroke);
await discoverLeader(); // This calls replayQueue() if new leader found

// replayQueue():
while (strokeQueue.length > 0 && currentLeader) {
  const stroke = strokeQueue.shift();
  await POST /client-stroke ...
}
```
Strokes are **never lost** during a leader change — they queue and replay in order.

**Step-down mid-forward detection:**
```js
if (!res.data.success) {
  // Leader responded but reported "not leader" — re-discover
  strokeQueue.push(stroke);
  await discoverLeader();
}
```
Handles the case where a leader steps down between `discoverLeader()` and the actual stroke forward.

---

## 6. `frontend/index.html` (89 lines)

### Layout
```
<header>
  Logo | Leader badge | Toolbar (colours + brush size + clear) | Status pill | Client count
</header>
<main>
  <canvas id="drawing-canvas">
  <div class="canvas-overlay">  ← shown when disconnected
</main>
<div id="toast-container">
```

### Toolbar Elements
| ID | Element | Purpose |
|---|---|---|
| `btn-colour-*` | `<button class="colour-btn">` | 7 colour swatches + eraser |
| `btn-eraser` | Colour button (white ✕) | Erase mode |
| `brush-size` | `<input type="range">` | 2–32px brush |
| `btn-clear` | `<button>` | Local canvas clear |
| `status-indicator` | `<div class="status">` | connected / reconnecting / disconnected |
| `leader-name` | `<span>` | Shows e.g. "replica1" |
| `count-value` | `<span>` | Connected client count from /health |

---

## 7. `frontend/style.css` (391 lines)

### Design System
```css
:root {
  --bg-deep:     #0d0d1a;   /* Page background */
  --bg-header:   #12122b;   /* Glassmorphism header */
  --bg-card:     #1a1a3a;   /* Toolbar background */
  --accent:      #7c6ff7;   /* Purple accent */
  --red:         #e94560;
  --green:       #4ade80;
  --yellow:      #fbbf24;
}
```

### Notable Styles
- **Status pill** — 3 states with distinct background/foreground:
  - `.connected`: green glow
  - `.reconnecting`: yellow, `pulse-badge` animation (opacity flicker)
  - `.disconnected`: red
- **Colour swatches** — scale on hover, white ring border when active
- **Canvas overlay** — blur backdrop + CSS spinner animation when disconnected
- **Toast** — slides in from bottom-right, colour-coded left border per type
- **Responsive** — logo text + leader badge hidden on screens < 700px

---

## 8. `frontend/app.js` (438 lines)

### WebSocket Client
```js
const GATEWAY_WS_URL = `ws://${location.hostname}:3000`;
let reconnectDelay = 500; // doubles on each failure, capped at 16000ms
```

**Reconnection loop:**
```js
ws.addEventListener('close', () => {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    connect();
  }, reconnectDelay);
});
```

### Incoming Message Handler
| `msg.type` | Action |
|---|---|
| `stroke-committed` | Dedup by `index`, push to `committedStrokes[]`, call `renderStroke()` |
| `full-sync` | Clear `committedStrokes[]`, push all, call `redrawAll()` |
| `pong` | No-op (keep-alive reply) |
| `error` | `showToast(msg.data.message, 'error')` |

### Canvas Drawing
- **HiDPI support**: canvas buffer scaled by `window.devicePixelRatio`
- **Resize**: `window.addEventListener('resize', resizeCanvas)` — re-scales buffer and calls `redrawAll()` (replays `committedStrokes[]`)
- **Mouse**: `mousedown → mousemove → mouseup/mouseleave`
- **Touch**: `touchstart → touchmove → touchend` with `passive: false`
- **Eraser**: sends `color: 'eraser'` — rendered with canvas background colour

### Stroke Send
```js
function onPointerUp(e) {
  // collect points during mousemove into currentStrokePoints[]
  // on release → send to Gateway:
  ws.send(JSON.stringify({
    type: 'stroke',
    data: { points: currentStrokePoints, color, width }
  }));
}
```

### Keep-alive Ping
```js
setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 20_000);
```
Prevents proxy/load-balancer idle-disconnect.

### Leader Badge Polling
```js
setInterval(async () => {
  const data = await fetch(`http://${location.hostname}:3000/health`).then(r => r.json());
  leaderNameEl.textContent = new URL(data.leader).hostname; // e.g. "replica1"
  countValueEl.textContent = data.clients;
}, 3000);
```

---

## 9. Dockerfiles — Fixed

### Problem
All three replicas had `EXPOSE 4001` and `CMD ["nodemon", "server.js"]` which caused nodemon to receive `exec` from `nodemon.json` AND `server.js` from the CLI — resulting in `node server.js server.js` in logs.

### Fix
| File | Before | After |
|---|---|---|
| `replica1/Dockerfile` | `EXPOSE 4001`, `CMD ["nodemon", "server.js"]` | `EXPOSE 4001`, `CMD ["nodemon"]` |
| `replica2/Dockerfile` | `EXPOSE 4001`, `CMD ["nodemon", "server.js"]` | `EXPOSE 4002`, `CMD ["nodemon"]` |
| `replica3/Dockerfile` | `EXPOSE 4001`, `CMD ["nodemon", "server.js"]` | `EXPOSE 4003`, `CMD ["nodemon"]` |

`CMD ["nodemon"]` — nodemon reads all config (watch, ext, ignore, exec) from `nodemon.json` without any CLI duplication.

---

## 10. Verified Live Cluster State

### Election Trace (from Docker logs)
```
replica1  jitter=0ms   → FOLLOWER(term 0) → CANDIDATE(term 1) → LEADER
replica2  jitter=50ms  → FOLLOWER(term 0) → FOLLOWER(term 1) ✓ Voted for replica1
replica3  jitter=100ms → FOLLOWER(term 0) → FOLLOWER(term 1) ✓ Voted for replica1
```

### Final Cluster State
```json
replica1: { state: "Leader",   term: 1, leader: "replica1" }
replica2: { state: "Follower", term: 1, leader: "replica1" }
replica3: { state: "Follower", term: 1, leader: "replica1" }
gateway:  { status: "ok", leader: "http://replica1:4001", clients: 0 }
```

### Port Map
| Service | Host Port | Container Port |
|---|---|---|
| Frontend | 8080 | 8080 |
| Gateway | 3000 | 3000 |
| replica1 | 4001 | 4001 |
| replica2 | 4002 | 4002 |
| replica3 | 4003 | 4003 |

---

## Known Issues / Not Yet Implemented (Week 3)

| Item | Location | Notes |
|---|---|---|
| Stroke queue replay (Week 3) | `leaderTracker.js` | Queue exists, basic replay done; needs retry limit |
| Canvas undo / redo | `frontend/app.js` | Not in scope yet |
| Persistent log storage | `replica/log.js` | In-memory only by design (SRS says non-persistent) |
| `docker-compose.yml version` warning | `docker-compose.yml` | Remove obsolete `version: "3.8"` attribute |
| Frontend served via nginx | `frontend/Dockerfile` | Currently uses serve/static server; check Dockerfile |
| Stroke dedup on reconnect | `frontend/app.js` | Currently deduplicates by `index` — requires leader to always assign monotonic index |

---

## Quick Start (after any code change)

```bash
# Rebuild and restart all containers (hot-reload also works via bind mounts)
docker compose up --build -d

# Check cluster health
curl http://localhost:4001/status
curl http://localhost:4002/status
curl http://localhost:4003/status
curl http://localhost:3000/health

# Follow live election/heartbeat logs
docker logs -f mini-raft-drawing-board-replica1-1

# Open the drawing board
open http://localhost:8080
```

---

## File Checksums (session end state)

| File | Lines | Purpose |
|---|---|---|
| `replica1/raft.js` | 603 | Full RAFT state machine |
| `replica1/log.js` | 100 | Append-only stroke log with truncateFrom |
| `replica1/server.js` | 80 | Replica HTTP + committed-log endpoint |
| `gateway/server.js` | 221 | WebSocket server + broadcast |
| `gateway/leaderTracker.js` | 178 | Leader discovery + stroke queue |
| `frontend/app.js` | 438 | Canvas drawing + WS client |
| `frontend/index.html` | 89 | Toolbar + canvas layout |
| `frontend/style.css` | 391 | Dark glassmorphism design |

All replica files (`raft.js`, `log.js`, `server.js`) are **identical across replica1/2/3** — verified by `md5sum`.
