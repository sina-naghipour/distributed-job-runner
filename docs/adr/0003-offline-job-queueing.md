# 3. Offline Job Queueing and Dynamic Agent Reconnection

Date: 2026-10-12
Status: Accepted

## Context
In a distributed edge/multi-datacenter environment, network partitions, container restarts, or maintenance windows frequently take agents offline. If a client submits a job targeted to an agent that is currently disconnected, discarding the job or throwing an immediate error would violate reliable delivery guarantees.

## Decision
We implement an **Offline Job Queue with Auto-Drain upon Reconnect**:
1. When a job is submitted via `POST /api/jobs`:
   - If the target agent's WebSocket connection is active, dispatch immediately (`DISPATCHED`).
   - If the agent is offline, buffer the request in `OfflineJobQueue` in FIFO order, keeping the state as `PENDING`.
2. A configurable watchdog timer (`timeoutMs`) is attached to each queued job. If the agent does not reconnect before the timeout expires, the job transitions to `TIMED_OUT` with exit code `124`.
3. When the agent connects (`AGENT_HELLO`), the gateway atomically drains the offline queue for that specific `agentId` and dispatches all buffered jobs sequentially.

## Consequences
- **Positive**:
  - Guaranteed delivery: zero lost jobs during transient agent downtime.
  - Automatic recovery without requiring client retry loops or polling.
  - Safe timeout bounds prevent jobs from hanging indefinitely in the queue.
- **Negative**:
  - Memory consumption scales with offline queue depth if agents remain offline indefinitely (mitigated by timeout expiration and queue depth limits).
