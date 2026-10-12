# Distributed Job Runner (DJR)

A resilient, production-grade distributed job execution platform running containerized tasks across remote agents.

Designed to address distributed communication, out-of-order state transitions, failure recovery, live streaming, artifact persistence, and multi-tenant agent routing behind NATs/firewalls.

---

## 🏗 High-Level Architecture

```
                      +---------------------------------------+
                      |               Clients                 |
                      |        (CLI / Web UI / REST)          |
                      +-------------------+-------------------+
                                          |
                                HTTP / SSE / REST
                                          v
                      +---------------------------------------+
                      |        Control Plane (Server)         |
                      |  - Job REST API (Idempotent Submissions)
                      |  - Agent Registry & Routing Engine    |
                      |  - State Machine & Transitions        |
                      |  - Live Log Broadcast (SSE/WS)        |
                      +-------+-----------------------+-------+
                              |                       |
               +--------------+                       +--------------+
               | State & Artifacts                                    | Bidirectional
               v                                                     v (WS / gRPC / Heartbeat)
  +-------------------------+                           +-------------------------+
  | PostgreSQL & Storage    |                           |     Agent Pool (NAT)    |
  | - Jobs & Execution Log  |                           +------------+------------+
  | - Final Log Artifacts   |                                        |
  +-------------------------+                    +-------------------+-------------------+
                                                 |                                       |
                                                 v                                       v
                                    +-------------------------+             +-------------------------+
                                    |    Agent 1 (Docker)     |             |    Agent 2 (Docker)     |
                                    | - Docker Socket Mount   |             | - Docker Socket Mount   |
                                    | - Execution Supervisor  |             | - Execution Supervisor  |
                                    | - Local Log Ring Buffer |             | - Local Log Ring Buffer |
                                    +------------+------------+             +------------+------------+
                                                 |                                       |
                                                 v (spawns)                              v (spawns)
                                    +-------------------------+             +-------------------------+
                                    | Isolated Job Container  |             | Isolated Job Container  |
                                    | (alpine / python / etc) |             | (alpine / python / etc) |
                                    +-------------------------+             +-------------------------+
```

---

## 📁 Repository Structure (npm Workspaces)

```
distributed-job-runner/
├── apps/
│   ├── control-plane/       # Central orchestrator: REST API, WS gateway, Job state machine
│   │   ├── src/
│   │   │   ├── api/         # Fastify/Express routes for jobs, agents, logs
│   │   │   ├── ws/          # WebSocket gateway managing reverse agent connections
│   │   │   ├── state/       # Job state transition engine & idempotency handler
│   │   │   ├── storage/     # Database layer (PostgreSQL / SQLite fallback)
│   │   │   └── index.ts     # Control plane bootstrap
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── agent/               # Containerized remote execution agent
│       ├── src/
│       │   ├── client/      # Outbound reverse connection to control plane
│       │   ├── docker/      # Docker engine API client (spawns isolated sibling containers)
│       │   ├── logs/        # Live log streaming & buffer manager
│       │   ├── supervisor/  # Job execution, timeout monitoring & orphan cleanup
│       │   └── index.ts     # Agent bootstrap
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   └── shared/              # Shared types, protocol contracts, schemas & utilities
│       ├── src/
│       │   ├── protocol.ts  # Agent-Server WebSocket messages & schemas
│       │   ├── types.ts     # Job, Agent, State Machine types
│       │   └── logger.ts    # Structured JSON logger (correlationId, jobId, agentId)
│       └── package.json
│
├── docker-compose.yml       # Orchestrates Control-Plane + 2 Agents + Demo Environment
├── .env.example             # Example environment variables
├── AI_USAGE.md              # Documentation of AI assistance & architectural rationale
├── README.md                # Project overview and roadmap
└── tsconfig.base.json       # Base TypeScript configuration
```

---

## 🚀 Step-by-Step Delivery Roadmap & Branches

| Stage | Branch | Focus | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Stage 1 (MVP)** | `stage-1-mvp` | **End-to-End Core Execution** | - Monorepo setup with shared types.<br>- Control plane REST API (`POST /api/jobs`, `GET /api/jobs/:id`).<br>- Containerized Agent connecting out to Control Plane.<br>- Agent spawns Docker sibling containers via `/var/run/docker.sock`.<br>- State flow: `PENDING` -> `DISPATCHED` -> `RUNNING` -> `SUCCEEDED`/`FAILED`.<br>- Single compose run demonstrating 1 job execution. |
| **Stage 2** | `stage-2-multi-agent-routing` | **Multi-Agent & Offline Queueing** | - Minimum 2 independent agents (`agent-alpha`, `agent-beta`).<br>- Targeted routing by `agentId`.<br>- Offline queueing: jobs queued when agent is disconnected, dispatched upon reconnect, or expired on timeout.<br>- Agent registration & heartbeat keep-alive. |
| **Stage 3** | `stage-3-logs` | **Live & Final Log Subsystem** | - Live streaming (stdout/stderr) over SSE / WS without blocking container execution.<br>- Final log storage as durable artifacts.<br>- Backpressure handling and viewer disconnect resilience. |
| **Stage 4** | `stage-4-reliability` | **Resilience, Idempotency & Reconciliation** | - `idempotencyKey` handling on submission.<br>- Connection loss mid-job & agent restart recovery.<br>- Orphan container reconciliation & cleanup on startup.<br>- Out-of-order and duplicate transition safety. |
| **Stage 5** | `stage-5-observability-demo` | **Observability, Scripts & Docs** | - Structured JSON logging (`traceId`, `jobId`, `agentId`).<br>- Automated demo script (`demo.sh` / `demo.ps1`) covering happy paths & failure scenarios.<br>- Final documentation, architecture trade-offs, and `AI_USAGE.md`. |

---

## 🛠 Prerequisites

- **Node.js**: v20+ (tested with v24.x)
- **npm**: v10+
- **Docker & Docker Compose**: v24+

---

## 🏃 Quick Start (Stage 1 MVP)

*(See branch `stage-1-mvp` for instructions once initialized)*
