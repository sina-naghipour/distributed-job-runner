# AI Usage & Architectural Rationale

This document tracks the tools, libraries, architectural trade-offs, and design choices used across the development of **Distributed Job Runner (DJR)**.

---

## 🤖 AI Assistance & Tools Used
- **Agent Assistance**: Code generation, scaffolding TypeScript workspaces, Docker engine API integration, state machine formalization, and test automation.
- **Developer Responsibility**: Full code verification, security audits (Docker socket access, container privilege dropping), error handling, and manual validation of failure scenarios.

---

## 🏛 Architectural Decisions & Trade-Offs

### 1. Reverse Connection Protocol: WebSocket vs. gRPC vs. Message Broker
- **Decision**: **WebSocket** (with extensible message contracts).
- **Rationale**:
  - Agents operate in remote datacenters or behind NATs and firewalls, unable to receive inbound TCP connections from the Control Plane.
  - WebSockets provide low-overhead bidirectional streaming over standard HTTP/TLS ports without requiring complex broker infrastructure for the MVP.
  - Native support for heartbeat (ping/pong) and fine-grained connection state tracking.
- **Trade-off Considered**:
  - *NATS JetStream / RabbitMQ*: Powerful for persistent message routing, but adds external infrastructure overhead for early stages. Our architecture decouples the gateway so a message broker can back the dispatch queue seamlessly if scaled horizontally.

### 2. Container-in-Container Execution: Docker Socket Mounting (DooD)
- **Decision**: Mount `/var/run/docker.sock` from the host into the Agent container.
- **Rationale**:
  - Avoids nested Docker daemon overhead (DinD) and privileged container security risks.
  - The agent interacts directly with the host daemon to spawn peer/sibling containers for each job with strict resource caps and isolation.

### 3. Log Architecture: Live Streaming vs. Final Artifact
- **Decision**: Decouple Live logs from Final logs.
  - **Live Log**: Pushed through in-memory chunk streams (WS/SSE) for real-time observation. Drops or disconnects on the viewer end do NOT terminate the job.
  - **Final Log**: Captured upon container exit and written to persistent storage (durable artifact), independent of container lifecycle or viewer presence.
