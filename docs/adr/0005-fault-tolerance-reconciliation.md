# 5. Fault Tolerance, Idempotency, and Crash Reconciliation

Date: 2026-10-12
Status: Accepted

## Context
Distributed systems experience partial failures:
1. **Network Retries**: A client might resubmit a job request due to an uncertain timeout or connection glitch, risking duplicate container launches.
2. **Out-of-Order / Duplicate Events**: Delayed network packets can cause state update events (e.g. `RUNNING` arriving after `SUCCEEDED`).
3. **Agent Process Crashes**: If an Agent crashes or the VM reboots mid-execution, worker containers running on the host Docker engine become orphans, consuming CPU and memory silently.

## Decision

### 1. Idempotent Job Submission
- The API accepts an optional client-provided `idempotencyKey`.
- If a submission with an identical key is received, the Control Plane immediately returns the previously created `jobId` and current state (`idempotentReplay: true`) rather than scheduling duplicate containers.

### 2. State Machine Transition Guard (`isValidStateTransition`)
- Strict transition table enforced:
  - `PENDING` -> `DISPATCHED` | `CANCELLED` | `TIMED_OUT`
  - `DISPATCHED` -> `RUNNING` | `FAILED` | `TIMED_OUT` | `CANCELLED`
  - `RUNNING` -> `SUCCEEDED` | `FAILED` | `TIMED_OUT` | `CANCELLED`
- Once a job reaches any terminal state (`SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`), subsequent late transitions or duplicate events are discarded idempotently without corrupting history.

### 3. Orphan Container Reconciliation (`cleanupOrphanedContainers`)
- Worker containers are tagged with Docker labels:
  - `djr.managed-by: djr-agent`
  - `djr.agent-id: <agentId>`
- On startup / reboot, the Agent supervisor queries Docker for containers matching its agent ID labels before opening connections.
- It forcefully purges any leftover or unmonitored containers, ensuring clean state after crashes.

## Consequences
- **Positive**:
  - Resilient against network retries and duplicate HTTP POST requests.
  - No container leakage or zombie processes consuming system RAM across restarts.
  - Safe against out-of-order WebSocket message arrival.
- **Negative**:
  - In-memory idempotency table requires a persistent backing store (e.g. Redis / PostgreSQL) for distributed multi-instance Control Planes.
