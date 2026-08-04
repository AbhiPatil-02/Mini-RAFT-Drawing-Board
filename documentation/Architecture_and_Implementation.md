# Documentation Audit & Architecture Guide

## Objective

Create a comprehensive architecture and implementation document by auditing the complete codebase. The document should explain not only **what** the system does, but also **how** and **why** each component works. It should follow the implementation flow from high-level architecture down to individual subsystems.

---

# Architecture & Implementation Document

## 1. Introduction
### 1.1 Project Overview
The Mini-RAFT Drawing Board is a distributed, real-time collaborative drawing application built upon the principles of the RAFT consensus algorithm. It allows multiple clients to connect through a centralized Gateway via WebSockets and collaboratively interact with a shared drawing canvas. The underlying state of the drawing board (a sequence of drawing strokes) is maintained by a cluster of replica nodes that communicate using the RAFT protocol to achieve strong consistency, fault tolerance, and high availability.

### 1.2 Purpose
The primary purpose of this project is to serve as an educational implementation and functional demonstration of distributed systems engineering. By integrating a complex backend consensus algorithm (RAFT) with a visual, real-time frontend application, it bridges the gap between theoretical distributed systems concepts and practical web development. It demonstrates how to handle leader election, log replication, and failover mechanisms seamlessly while maintaining a responsive user experience. 

### 1.3 Key Features
- **Real-Time Collaboration**: Multiple users can draw on the canvas simultaneously, seeing each other's strokes in real-time.
- **RAFT Consensus Implementation**: A fully functional, custom-built Node.js implementation of the RAFT protocol handling leader election, term management, and strict log matching.
- **High Availability & Fault Tolerance**: The system is designed to survive node failures. If the leader node crashes, the remaining follower nodes automatically initiate a new election to establish a new leader without human intervention.
- **WebSocket Gateway Routing**: A centralized gateway transparently handles WebSocket connections from web clients and routes drawing actions to the current RAFT leader.
- **Dockerized Architecture**: The entire application (frontend, gateway, and replicas) is containerized using Docker and orchestrated with Docker Compose, ensuring consistent deployment and isolated networking via internal bridges.

### 1.4 Technology Stack
- **Frontend / Client UI**: 
  - Vanilla HTML5, CSS3, and JavaScript.
  - Deployed using `http-server` acting as a static file server within a Node.js Alpine container.
- **Gateway Service**: 
  - Node.js running an Express HTTP API and a `ws` (WebSocket) server.
  - `axios` for HTTP REST communication with the backend replicas.
- **Replica Nodes (RAFT Cluster)**: 
  - Node.js and Express for HTTP-based inter-node RPC communication.
  - `nodemon` utilized in development for hot-bounded reloads.
- **Infrastructure**: 
  - Docker Desktop / Engine (v24+) and Docker Compose (v2+).
  - Internal Docker Bridge networking (`raft-net`) isolates intra-cluster and gateway communication from the host environment.

### 1.5 Repository Structure
The repository is explicitly decoupled into independent microservices, facilitating modular development and individual scaling:
- **`/frontend`**: Contains the client-facing UI logic (`index.html`, `style.css`, `app.js`) and its respective `Dockerfile`.
- **`/gateway`**: Houses the gateway application (`server.js`, `leaderTracker.js`), responsible for proxying WebSocket connections and tracking the current RAFT leader.
- **`/replica1`, `/replica2`, `/replica3`**: Although structurally identical in logic, these are segregated directories representing the persistence nodes in the RAFT cluster. They contain the core RAFT algorithm implementation.
- **`/documentation`**: A central hub for architectural records, software requirement specifications (SRS), and implementation plans.
- **`docker-compose.yml`**: The declarative orchestration file that wires the microservices together, provisions the unified `raft-net` network, and defines container scaling behavior.
- **`README.md`**: Outlines quick-start commands, project architecture at a glance, and common developer workflows.

## 2. System Design & Architecture
### 2.1 High-Level Architecture
The system employs a standard three-tier distributed architecture augmented with WebSocket communication and a Raft-based backend:
- **Client Tier**: Browser-based stateless clients rendering the collaborative canvas.
- **Gateway Tier**: A central WebSocket server that masks the complexity of the backend cluster, scales horizontally for concurrent connections, and manages board rooms (multi-tenancy). 
- **Consensus Tier**: A backend cluster of identical HTTP servers acting as RAFT nodes. These nodes strictly enforce distributed consensus to serialize client operations into an immutable, replicated log.

### 2.2 Architectural Principles
- **Decoupled Frontend**: The frontend holds absolutely no synchronization logic. It renders exact data provided by the Gateway via `full-sync` and applies incremental `stroke-committed` events.
- **Single Source of Truth**: The RAFT cluster Leader is the only entity permitted to append new data to the log. Conflicts are theoretically eliminated by strictly appending via a single leader.
- **Fault Isolation**: If a replica node fails, client WebSocket connections are untouched because they only connect directly to the Gateway.
- **Graceful Degradation**: If the Leader node goes offline, the Gateway does not drop clients. Instead, it queues incoming drawing strokes and broadcasts a `leader-changing` status, delivering the strokes once recovery concludes.

### 2.3 System Components
- **The Browser Client (`app.js`, `index.html`)**: Handles UI rendering and capturing DOM pointer events (mouse/touch), emitting a `stroke` payload over WebSockets.
- **The Gateway (`server.js`)**: Exposes the WebSocket server handling initial connections into specific board rooms based on `join-board` events. It forwards strokes dynamically via an HTTP POST request to wherever the current leader is.
- **The Leader Tracker (`leaderTracker.js`)**: A background worker in the gateway that continuously probes the backend to identify the authoritative Leader. It transparently resolves who holds the highest committed log and the current `Term`.
- **The RAFT Node (`server.js`, `raft.js`)**: An HTTP server exposing standard algorithms of RAFT consensus (`/request-vote`, `/append-entries`, `/heartbeat`). Each node maintains persistent internal state per board mapping (log index, terms, uncommitted and committed strokes).

### 2.4 Request Lifecycle
1. **Connection Initialization**: A client establishes a WS connection to the Gateway and joins a specific board room (e.g., `boardId: "board-public"`).
2. **State Hydration**: The Gateway requests the `/committed-log` from the current Leader and pipes this immediately to the joining client as a `full-sync` payload so they see the current board state.
3. **User Action**: The User draws a stroke on the canvas. The browser packages the vector points and emits a `stroke` WS message.
4. **Proxy Forwarding**: The Gateway identifies the payload and forwards it in an HTTP `POST` to the Leader.
5. **Consensus Achievement**: The Leader appends the stroke to its volatile uncommitted log and issues `append-entries` RPCs to its followers. Upon receiving confirmations from a majority (quorum), the Leader upgrades the stroke to _committed_.
6. **Delivery**: The Leader invokes the Gateway’s `POST /broadcast` webhook. The Gateway relays this exclusively to clients authenticated in that `boardId` room via a `stroke-committed` WS message.

### 2.5 Data Flow
The canonical flow of a single drawing stroke moves strictly in a unidirectional loop:
`Input Event (Browser) -> WebSocket JSON -> Gateway Server -> Axios REST POST -> RAFT Leader (Uncommitted) -> RAFT Followers (Replication) -> RAFT Leader (Committed) -> Axios REST Webhook -> Gateway Server -> WebSocket Broadcast -> Canvas Redraw (Browser)`.

### 2.6 Service Communication
- **Client ↔ Gateway**: Bidirectional WebSocket connection. Payloads contain an explicit `type`, `boardId`, and `data`.
- **Gateway ↔ RAFT Leader**: Traditional synchronous HTTP REST. The Gateway sends commands via POST `/client-stroke` and retrieves data via GET `/committed-log` or GET `/status`.
- **Gateway ← RAFT Leader**: Webhook push notifications. When the Leader commits an entry, it pushes to the Gateway's POST `/broadcast` endpoint to notify the entire client pool.
- **RAFT Node ↔ RAFT Node**: Internal HTTP RPC equivalents for algorithm synchronization (POST `/heartbeat`, POST `/request-vote`, POST `/append-entries`, POST `/sync-log`).

### 2.7 Failure Handling Strategy
The system integrates layered resilience capabilities:
- **Replica Crashes**: Follower notes crash immediately because the Gateway routes to Leader. Quorum ensures durability as long as N/2 + 1 nodes survive. 
- **Leader Crashes**: Remaining followers recognize missing heartbeats, bump their RAFT active term, and initiate a decentralized election process.
- **Client Resilience**: The Gateway's `leaderTracker.js` identifies that target API calls to the Leader are failing. The tracker engages a `failoverActive` state, buffering all new incoming frontend WebSocket strokes in memory. The Gateway issues a WS `leader-changing` payload indicating degraded performance to end-users without disrupting UI state. Once the cluster promotes a new Leader, the backlog is sequentially replayed to the new Leader and `leader-restored` is dispatched.

## 3. Distributed System Architecture
### 3.1 Why Distributed?
A single-server model is a single point of failure (SPOF) and struggles with high state durability when crashes occur. Operating in a distributed cluster enforces high availability—the system remains functional as long as a majority of nodes are operational. It introduces students and practitioners to the complexities of distributed consensus, state machine replication, and cluster observability without enterprise overhead.

### 3.2 Node Responsibilities
Nodes in the RAFT cluster hold equal capability but take on distinct algorithmic responsibilities based on their current state:
- **Leader**: Solely responsible for receiving write requests (drawing strokes) from the Gateway, sequencing them into the log, sending `append-entries` RPCs to followers, committing entries upon majority acknowledgement, and triggering the Gateway broadcast webhook.
- **Follower**: Strictly passive. Responds to `append-entries` (log replication) and `heartbeat` messages from the Leader, and `request-vote` messages from Candidates. Replicates the log faithfully.
- **Candidate**: A transitional state initiated when a Follower stops receiving heartbeats. The Candidate increments the election term, votes for itself, and actively issues `request-vote` RPCs to peers to seize leadership.

### 3.3 Cluster Formation
The RAFT cluster is statically configured upon startup using environment variables managed by Docker Compose. Each Replica node is provisioned with its own distinct `PORT`, `REPLICA_ID` (e.g., `replica1`), and a strictly defined list of `PEERS` in a comma-separated format (e.g., `replica2:4002,replica3:4003`). `config.js` immediately parses this list on boot, mapping them to full HTTP URLs. The cluster size (`N`) is derived dynamically mathematically as `PEERS.length + 1`, and the `MAJORITY` is computed as `Math.floor(N/2) + 1`.

### 3.4 Inter-node Communication
Internal peer-to-peer cluster chatter relies intrinsically on HTTP REST via the `axios` client targeting Express.js boundaries. Node communication happens with extremely tight, explicit timeouts (e.g., `RPC_TIMEOUT_MS = 300`) ensuring the distributed system does not permanently hang on unreachable peers. Responses typically yield standard JSON encompassing the replica's `term` and a `success` boolean.

### 3.5 Fault Tolerance
The RAFT cluster implements an `F = (N-1)/2` fault tolerance limit. In our default 3-node topology, the cluster securely sustains `1` simultaneous node failure without data loss or application downtime, since a 2-node majority still remains. When a failed node recovers, its `raft.js` process boots, starts as a Follower at Term 0. Upon the next heartbeat from the live Leader, it adopts the Leader's Term, discovers its log is severely disjointed, and the Leader automatically triggers a `POST /sync-log` burst catch-up transferring all missing strokes.

### 3.6 Network Partition Handling
The strict reliance on a numeric `MAJORITY` intrinsically mitigates "split-brain" (network partition) disasters. 
- If the cluster splits into a group of 2 and an isolated 1, the group of 2 retains quorum and operates normally as the Leader.
- The isolated node, noticing missing heartbeats, attempts an election. It fails permanently because it cannot accumulate 2 votes, entering a cyclic Candidate loop. Any client traffic wrongly forwarded to this isolated node is rejected ("no quorum"). 
- A specialized mechanism, **Leader Stickiness**, exists where nodes explicitly refuse to vote for candidates if they have observed valid heartbeats from a live leader within the minimum election window (e.g., `< 500ms`).

### 3.7 Scalability Considerations
The consensus tier favors strong consistency over raw write latency throughput. As the cluster config scales horizontally (e.g., to 4 or 5 nodes via config injection), fault tolerance increases, but write delays also marginally increase due to synchronous majority RPC acknowledgement requirements. The Gateway tier is loosely coupled, meaning clients solely connect to the gateway and the backend scale adjustments are abstracted away from client connections.

## 4. RAFT Consensus Algorithm
### 4.1 Introduction to RAFT
RAFT is a distributed consensus algorithm designed for state dependencies that emphasizes understandability. It works by strictly decomposing the consensus problem into three relatively independent subproblems: Leader Election, Log Replication, and Safety. In this system, RAFT is strictly utilized to ensure that all Drawing Board clients receive the same chronological sequence of drawing strokes in exactly the same order.

### 4.2 Why RAFT Was Chosen
Compared to algorithms like Paxos, RAFT eliminates ambiguous edge cases by strictly enforcing a strong single-leader model. The log only flows in one direction: from the Leader to the Followers. Furthermore, RAFT simplifies log conflict mechanisms. Rather than attempting to merge or reconstruct diverging logs identically, RAFT establishes that the highest Term Leader's log is unequivocally correct, allowing it to forcefully truncate any conflicting follower logs.

### 4.3 Cluster Membership
Membership in our Mini-RAFT implementation is static. The configuration dictates nodes available (e.g., Replica 1, Replica 2, Replica 3). To alter the membership to a 4 or 5 node topography, the environment variables dictating `PEERS` via Docker Compose must be overridden during the initialization phase. The algorithm calculates the minimum active `MAJORITY` statically as `Math.floor(N/2) + 1` (e.g., N=3, MAJORITY=2).

### 4.4 Terms
Time in RAFT is divided into arbitrary lengths called `Terms`. Each Term acts as a logical clock and is continuously monotonic. A new Term natively starts alongside a leader election round when a Candidate steps up. If a peer ever receives a payload containing a Term strictly greater than its own internal `currentTerm`, it immediately abolishes its position (even if it's the Leader), updates its clock to the new Term, and resets itself to the `Follower` state. 

### 4.5 Commit Index
Both the Leader and Followers maintain a `commitIndex`—an integer reflecting the highest log entry index verified to be replicated across a majority of servers. The Leader tracks appending replies and advances its internal `commitIndex` locally. Followers learn that strokes were safely committed out-of-band via the `leaderCommit` property passed down in continuous heartbeats. When a follower detects `leaderCommit > commitIndex`, it applies these entries sequentially to its local state machine. Crucially, the Mini-RAFT implementation scopes this per-board using a mapped dictionary `boardCommitIndex` mapping `boardId` to `commitIndex`.

### 4.6 Leader Responsibilities
The designated Leader must autonomously control all state shifts. No write strokes bypass the Leader. 
- Serves all frontend Gateway client requests via `/client-stroke`.
- Replicates new strokes instantly to Followers via `/append-entries`.
- Monitors acknowledgment statuses and determines quorum to shift stroke entries from "Uncommitted" to "Committed".
- Emits WebSocket Webhook updates (`/broadcast`) directly to the Gateway once consensus validates state shifts.
- Ensures Followers lag is controlled by bursting `/sync-log` payloads if index disparities widen.

### 4.7 Heartbeats
Nodes do not use a dedicated heartbeat API. Instead, RAFT exploits the `AppendEntries` RPC format. A heartbeat is fundamentally just an `AppendEntries` HTTP payload containing zero stroke data. The Leader dispatches these every `500ms` (`HEARTBEAT_INTERVAL_MS`). By constantly refreshing Followers with heartbeats, the internal timeout timers of Followers are constantly cleared, safely staving off unnecessary Candidate elections.

### 4.8 Safety Guarantees
Mini-RAFT securely embodies the five core algorithmic safety assurances of RAFT:
1. **Election Safety**: At most, one leader can be elected in a given Term. (Ensured by nodes strictly casting one vote per term).
2. **Leader Append-Only**: A leader never overwrites or deletes entries in its own log, it merely appends.
3. **Log Matching**: If two logs share an entry with the same index and term, those logs are identical in all preceding entries. 
4. **Leader Completeness**: If a stroke is globally committed in one Term, that stroke is persistently present in the logs of the leaders for all future higher Terms.
5. **State Machine Safety**: Since strokes are inherently commutative/linear when drawn chronologically, ensuring all Replicas apply the explicit matching log index sequence guarantees eventual state mirroring.

## 5. Leader Election
### 5.1 Election Process
If a Follower node receives no communication (heartbeat/AppendEntries) from the Leader over a specified timeframe, it assumes there is no viable Leader. The node transitions to a `Candidate` state, increments its current `Term`, votes for itself, and broadcasts a `request-vote` RPC in parallel to all other nodes in the cluster to initiate a formal election. 

### 5.2 Election Timeout
To prevent synchronized split votes—where multiple Followers become Candidates simultaneously—the election timeout is randomized. Each node determines its timeout duration by picking a random millisecond value between `ELECTION_TIMEOUT_MIN_MS` (500ms) and `ELECTION_TIMEOUT_MAX_MS` (800ms). This randomization practically guarantees one Follower will time out slightly before the others, allowing it to start collecting votes before peers trigger pseudo-concurrent elections.

### 5.3 Vote Request Flow
When calling `/request-vote`, the Candidate is required to provide its ID, current Term, and metrics regarding log freshness (`lastLogIndex` and `lastLogTerm`). This data allows receiving peers to make an informed decision about whether providing a vote is safe, preserving strict log integrity across the cluster.

### 5.4 Vote Response Handling
When a node receives a `request-vote` RPC, it adheres to the following logic:
1. **Term Verification**: It denies the vote if the Candidate's Term is less than the node's `currentTerm`.
2. **Leader Stickiness Check**: It denies the vote if it has heard from an active Leader within the minimum election timeout bound (preventing a rogue restarting node with a high term from arbitrarily disrupting a healthy cluster).
3. **Double Vote Prevention**: It denies the vote if it has already cast a vote for another Candidate in this exact Term.
4. **Log Freshness Verification**: It denies the vote if the Candidate’s log is computationally "stale" compared to its own (comparing the last log's Term and Index).
If all checks pass, it returns `voteGranted: true`, adopts the `Follower` state, records the vote locally, and resets its own election timer.

### 5.5 Split Vote Recovery
If multiple Candidates run simultaneously and votes are split such that nobody secures a strict majority, the nodes’ candidate election timeout clocks will eventually expire with no Leader established. Because the timeout values are re-randomized on every new loop, the likelihood of consecutive split votes drops exponentially. On the subsequent retry, one Candidate will reliably timeout earlier and secure the cluster.

### 5.6 Re-election Process
If an established Leader crashes, heartbeat deliveries cease. Within 500-800ms, the closest remaining Follower converts to a Candidate and initiates a re-election. The Gateway's internal WebSocket queues elegantly buffer incoming client drawing traffic during this brief <1s window, creating a resilient pipeline that masks the backend leadership transition from end clients.

### 5.7 Leader Failover
During a failover phase, recovering machines (like the previous crashed Leader rebooting) restore their filesystem, but inherently boot cleanly in the passive `Follower` state at Term 0. Upon hearing a heartbeat from the newly dominant Leader, their internal `currentTerm` is corrected upwards, abolishing past leader aspirations and yielding entirely to the active elected Leader automatically via the `/sync-log` pipeline.

## 6. Log Replication
### 6.1 Log Structure
*Placeholder content*

### 6.2 AppendEntries RPC
*Placeholder content*

### 6.3 Commit Flow
*Placeholder content*

### 6.4 Log Matching Property
*Placeholder content*

### 6.5 Conflict Resolution
*Placeholder content*

### 6.6 Log Recovery
*Placeholder content*

### 6.7 Consistency Guarantees
*Placeholder content*

## 7. Node States
### 7.1 Follower Mode
* Responsibilities: *Placeholder content*
* Heartbeat Handling: *Placeholder content*
* Timeout Behaviour: *Placeholder content*
* State Transitions: *Placeholder content*

### 7.2 Candidate Mode
* Election Initialization: *Placeholder content*
* Vote Collection: *Placeholder content*
* Election Timeout: *Placeholder content*
* Transition Logic: *Placeholder content*

### 7.3 Leader Mode
* Client Request Handling: *Placeholder content*
* Log Replication: *Placeholder content*
* Heartbeat Broadcasting: *Placeholder content*
* Leadership Transfer: *Placeholder content*
* Failure Detection: *Placeholder content*

## 8. Election Rules
### 8.1 Voting Rules
*Placeholder content*

### 8.2 Majority Quorum
*Placeholder content*

### 8.3 Term Validation
*Placeholder content*

### 8.4 Log Freshness Rules
*Placeholder content*

### 8.5 Leader Validity
*Placeholder content*

### 8.6 Safety Rules
*Placeholder content*

## 9. State Replication
### 9.1 State Machine
*Placeholder content*

### 9.2 State Synchronization
*Placeholder content*

### 9.3 Commit Application
*Placeholder content*

### 9.4 Snapshot Strategy
*Placeholder content*

### 9.5 Recovery After Restart
*Placeholder content*

### 9.6 Consistency Guarantees
*Placeholder content*

## 10. Networking Layer
### 10.1 Communication Protocols
*Placeholder content*

### 10.2 RPC Implementation
*Placeholder content*

### 10.3 Message Formats
*Placeholder content*

### 10.4 Retry Strategy
*Placeholder content*

### 10.5 Error Handling
*Placeholder content*

### 10.6 Timeout Strategy
*Placeholder content*

## 11. WebSocket Architecture
### 11.1 Why WebSockets
*Placeholder content*

### 11.2 Connection Lifecycle
*Placeholder content*

### 11.3 Client Session Management
*Placeholder content*

### 11.4 Event Flow
*Placeholder content*

### 11.5 Broadcasting
*Placeholder content*

### 11.6 Authentication
*Placeholder content*

### 11.7 Reconnection Logic
*Placeholder content*

### 11.8 Scaling WebSockets
*Placeholder content*

## 12. API Layer
### 12.1 API Architecture
*Placeholder content*

### 12.2 Request Routing
*Placeholder content*

### 12.3 Request Validation
*Placeholder content*

### 12.4 Response Format
*Placeholder content*

### 12.5 Error Responses
*Placeholder content*

### 12.6 Middleware Flow
*Placeholder content*

## 13. Storage Layer
### 13.1 Persistent Storage
*Placeholder content*

### 13.2 Log Storage
*Placeholder content*

### 13.3 Metadata Storage
*Placeholder content*

### 13.4 Snapshot Storage
*Placeholder content*

### 13.5 Recovery Process
*Placeholder content*

## 14. Data Models
### 14.1 Domain Models
*Placeholder content*

### 14.2 Replicated Objects
*Placeholder content*

### 14.3 Log Entry Schema
*Placeholder content*

### 14.4 Message Structures
*Placeholder content*

### 14.5 Serialization Strategy
*Placeholder content*

## 15. Concurrency Model
### 15.1 Threading Model
*Placeholder content*

### 15.2 Synchronization
*Placeholder content*

### 15.3 Locks
*Placeholder content*

### 15.4 Race Condition Prevention
*Placeholder content*

### 15.5 Concurrent Replication
*Placeholder content*

## 16. Failure Recovery
### 16.1 Node Failure
*Placeholder content*

### 16.2 Leader Failure
*Placeholder content*

### 16.3 Crash Recovery
*Placeholder content*

### 16.4 Disk Recovery
*Placeholder content*

### 16.5 Network Recovery
*Placeholder content*

### 16.6 Split Brain Prevention
*Placeholder content*

## 17. Docker & Containerization
### 17.1 Docker Architecture
*Placeholder content*

### 17.2 Dockerfile Walkthrough
*Placeholder content*

### 17.3 Docker Compose
*Placeholder content*

### 17.4 Container Networking
*Placeholder content*

### 17.5 Environment Configuration
*Placeholder content*

### 17.6 Volumes
*Placeholder content*

### 17.7 Health Checks
*Placeholder content*

### 17.8 Startup Order
*Placeholder content*

## 18. Containerization & Service Isolation
### 18.1 Service Boundaries
*Placeholder content*

### 18.2 Container Responsibilities
*Placeholder content*

### 18.3 Isolation Strategy
*Placeholder content*

### 18.4 Resource Allocation
*Placeholder content*

### 18.5 Inter-service Communication
*Placeholder content*

### 18.6 Deployment Strategy
*Placeholder content*

## 19. Configuration Management
### 19.1 Environment Variables
*Placeholder content*

### 19.2 Cluster Configuration
*Placeholder content*

### 19.3 Runtime Configuration
*Placeholder content*

### 19.4 Feature Flags
*Placeholder content*

## 20. Security
### 20.1 Authentication
*Placeholder content*

### 20.2 Authorization
*Placeholder content*

### 20.3 Secure Communication
*Placeholder content*

### 20.4 Input Validation
*Placeholder content*

### 20.5 Secrets Management
*Placeholder content*

## 21. Monitoring & Observability
### 21.1 Logging
*Placeholder content*

### 21.2 Metrics
*Placeholder content*

### 21.3 Health Endpoints
*Placeholder content*

### 21.4 Debugging Strategy
*Placeholder content*

### 21.5 Performance Monitoring
*Placeholder content*

## 22. Testing Strategy
### 22.1 Unit Tests
*Placeholder content*

### 22.2 Integration Tests
*Placeholder content*

### 22.3 Distributed Tests
*Placeholder content*

### 22.4 Failure Simulation
*Placeholder content*

### 22.5 Load Testing
*Placeholder content*

## 23. Performance Considerations
### 23.1 Replication Performance
*Placeholder content*

### 23.2 Network Optimization
*Placeholder content*

### 23.3 Memory Usage
*Placeholder content*

### 23.4 Disk Usage
*Placeholder content*

### 23.5 Scalability Benchmarks
*Placeholder content*

## 24. Codebase Audit
### 24.1 Project Structure Analysis
*Placeholder content*

### 24.2 Module-by-Module Review
*Placeholder content*

### 24.3 Dependency Graph
*Placeholder content*

### 24.4 Execution Flow
*Placeholder content*

### 24.5 Critical Components
*Placeholder content*

### 24.6 Configuration Files
*Placeholder content*

### 24.7 Startup Sequence
*Placeholder content*

### 24.8 Shutdown Sequence
*Placeholder content*

## 25. Sequence Diagrams
### 25.1 System Startup
*Placeholder content*

### 25.2 Leader Election
*Placeholder content*

### 25.3 Log Replication
*Placeholder content*

### 25.4 Client Request Flow
*Placeholder content*

### 25.5 WebSocket Communication
*Placeholder content*

### 25.6 Failure Recovery
*Placeholder content*

### 25.7 Node Rejoin
*Placeholder content*

## 26. Architecture Diagrams
### 26.1 Overall System Architecture
*Placeholder content*

### 26.2 Distributed Cluster
*Placeholder content*

### 26.3 RAFT Workflow
*Placeholder content*

### 26.4 State Machine
*Placeholder content*

### 26.5 Networking Architecture
*Placeholder content*

### 26.6 Docker Deployment
*Placeholder content*

### 26.7 Service Dependency Graph
*Placeholder content*

## 27. Deployment Guide
### 27.1 Prerequisites
*Placeholder content*

### 27.2 Local Development
*Placeholder content*

### 27.3 Docker Deployment
*Placeholder content*

### 27.4 Multi-node Deployment
*Placeholder content*

### 27.5 Production Deployment
*Placeholder content*

### 27.6 Scaling the Cluster
*Placeholder content*

## 28. Troubleshooting
### 28.1 Common Issues
*Placeholder content*

### 28.2 Leader Election Problems
*Placeholder content*

### 28.3 Replication Failures
*Placeholder content*

### 28.4 Docker Issues
*Placeholder content*

### 28.5 Network Problems
*Placeholder content*

### 28.6 Recovery Procedures
*Placeholder content*

## 29. Future Improvements
### 29.1 Snapshot Optimization
*Placeholder content*

### 29.2 Dynamic Cluster Membership
*Placeholder content*

### 29.3 Performance Enhancements
*Placeholder content*

### 29.4 Security Improvements
*Placeholder content*

### 29.5 Observability Enhancements
*Placeholder content*

## 30. Appendix
### 30.1 Glossary
*Placeholder content*

### 30.2 References
*Placeholder content*

### 30.3 Important Algorithms
*Placeholder content*

### 30.4 Configuration Reference
*Placeholder content*

### 30.5 API Reference
*Placeholder content*

### 30.6 RPC Reference
*Placeholder content*

### 30.7 Environment Variables
*Placeholder content*

### 30.8 Acronyms
*Placeholder content*

---

## Documentation Audit Process
*Pending execution in subsequent iterations*
