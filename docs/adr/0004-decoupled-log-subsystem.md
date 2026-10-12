# 4. Decoupled Live Streaming and Durable Final Log Artifacts

Date: 2026-10-12
Status: Accepted

## Context
In containerized batch/job execution:
1. Users need real-time feedback (watching `stdout` and `stderr` live as the task runs).
2. Users frequently disconnect, close their browser tab, or network hops drop the stream.
3. Once containers terminate and are deleted to free system resources, their standard Docker logs disappear.
4. Final logs must remain permanently available for audit, debugging, and retrieval without requiring the container to stay alive.

## Decision
We decouple **Live Logs** from **Final Logs**:

### 1. Live Log Broadcast (`LogStreamBroadcaster`)
- Implements Server-Sent Events (SSE) via `GET /api/jobs/:id/logs/stream`.
- When an agent emits `JOB_LOG_CHUNK` messages, the Control Plane multiplexes them to all currently active SSE subscribers.
- **Client Disconnect Resilience**: Viewer socket disconnections trigger an Express `close` cleanup event. The worker container's execution and log harvesting on the agent continue uninterrupted.
- **Backlog Replay**: New subscribers receive all preceding chunks in order before live streaming begins.

### 2. Durable Final Log Artifacts (`LogArtifactManager`)
- Upon receiving `JOB_COMPLETED`, the Control Plane automatically writes the combined, ordered log chunks to a durable file artifact (`./data/logs/<jobId>.log`).
- `GET /api/jobs/:id/logs` looks up memory, and falls back to disk artifact storage.
- Storage volumes (`./data/logs`) survive container lifecycle restarts and removals.

## Consequences
- **Positive**:
  - Zero coupling between viewer presence and job execution stability.
  - Safe garbage collection of finished worker containers without losing audit trails.
  - Low-overhead SSE streaming supported natively by all web browsers and HTTP tools without extra client libraries.
- **Negative**:
  - Disk storage accumulates over time; requires retention policies / cleanup jobs for production scale.
