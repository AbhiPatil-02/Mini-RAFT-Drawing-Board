# Mini-RAFT Drawing Board

A distributed real-time collaborative drawing board built with a Mini-RAFT consensus protocol.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/) ≥ 2

## Getting Started

```bash
# Clone the repository
git clone <repo-url>
cd Mini-RAFT-Drawing-Board

# Build and start all services
docker-compose up --build
```

Open your browser at **http://localhost:8080** to access the drawing board.

## Services

| Service   | URL                        | Description                  |
|-----------|----------------------------|------------------------------|
| Frontend  | http://localhost:8080      | Browser drawing canvas       |
| Gateway   | http://localhost:3000      | WebSocket server             |
| Replica 1 | http://localhost:4001      | RAFT consensus node          |
| Replica 2 | http://localhost:4002      | RAFT consensus node          |
| Replica 3 | http://localhost:4003      | RAFT consensus node          |

## Common Commands

```bash
# Start all services (detached)
docker-compose up -d --build

# View logs for a specific service
docker logs -f replica1

# Simulate a leader failure
docker-compose stop replica1

# Restart a replica (simulates hot-reload)
docker-compose restart replica1

# Trigger hot-reload by editing source
# (edit any file in replica1/ — container restarts automatically)

# Check RAFT status of all replicas
curl http://localhost:4001/status
curl http://localhost:4002/status
curl http://localhost:4003/status

# Tear down everything
docker-compose down
```

## Documentation

- [`documentation/SRS_Document.md`](documentation/SRS_Document.md) — Requirements, API specs, protocol spec
- [`documentation/Implementation_Plan.md`](documentation/Implementation_Plan.md) — Week-wise plan, Docker setup, testing strategy