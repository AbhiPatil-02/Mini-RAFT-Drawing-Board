# Mini-RAFT Drawing Board

A **Distributed Real-Time Drawing Board** built with Node.js, Socket.io, and a from-scratch Mini-RAFT consensus implementation.

Users draw on a browser canvas and every stroke is instantly replicated to all connected clients through a RAFT-consensus log.

---

## Features

- 🎨 **Freehand drawing** – pen and eraser tools, colour palette, custom colour picker, adjustable brush size
- ⚡ **Real-time sync** – every committed stroke is broadcast to all connected browsers via Socket.io
- 🗂 **Full history replay** – new clients receive the complete drawing history on connect
- 🏛 **Mini-RAFT consensus** – leader election with randomized timeouts, log replication of drawing strokes, majority-commit, and heartbeat-based lease renewal
- 🌐 **Multi-node cluster** – run multiple server instances that elect a leader among themselves

---

## Quick Start

### Single-node (simplest)

```bash
npm install
npm start
# Open http://localhost:3000 in one or more browsers
```

The single node becomes the RAFT leader within a few seconds and all drawing is live.

### Three-node cluster

Open three terminals:

```bash
node server.js --port=3000 --id=1 --peers=http://localhost:3001,http://localhost:3002
node server.js --port=3001 --id=2 --peers=http://localhost:3000,http://localhost:3002
node server.js --port=3002 --id=3 --peers=http://localhost:3000,http://localhost:3001
```

Connect browsers to any node. A leader is elected via RAFT and all drawing strokes are replicated through the consensus log.

---

## Architecture

```
Browser ──(Socket.io)──► Server (RAFT node)
                            │
                   ┌────────┴────────┐
                   │                 │
            HTTP RPC             HTTP RPC
            (RequestVote)        (AppendEntries)
                   │                 │
               Peer node        Peer node
```

| Component | File | Description |
|---|---|---|
| RAFT Node | `src/raft/RaftNode.js` | Leader election, log replication, heartbeats |
| Server | `server.js` | Express + Socket.io, RAFT RPC endpoints |
| Frontend | `public/` | Canvas drawing, RAFT status panel |

---

## API

### RAFT RPC (inter-node, HTTP)

| Endpoint | Description |
|---|---|
| `POST /raft/requestVote` | Candidate requests a vote |
| `POST /raft/appendEntries` | Leader sends heartbeat / log entries |
| `POST /raft/clientDraw` | Follower proxies a client stroke to the leader |
| `GET  /raft/status` | Returns current RAFT state (debugging) |

### Socket.io events (browser ↔ server)

| Event | Direction | Payload |
|---|---|---|
| `draw` | client → server | Stroke object `{ type, points, color, size }` |
| `stroke` | server → client | Committed stroke broadcast to all |
| `history` | server → client | Full stroke history on connect |
| `raftState` | server → client | Live RAFT node state |
