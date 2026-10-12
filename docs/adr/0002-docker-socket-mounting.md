# 2. Container Execution via Docker Socket Mounting (DooD)

Date: 2026-10-12
Status: Accepted

## Context
Jobs must execute in isolated Docker containers with customizable images, environment variables, commands, and memory limits. The Agent itself is containerized.

## Decision
Mount the host Docker socket (`/var/run/docker.sock`) into the Agent container rather than running Docker-in-Docker (DinD).

## Consequences
- **Positive**:
  - Avoids running privileged containers (`--privileged`).
  - Reuses host image caches without redundant downloads.
  - Sibling containers run as first-class citizens alongside the agent on the host engine.
- **Negative**:
  - The agent container shares host daemon access; requires proper process permissions and label scoping (`djr.managed-by=djr-agent`).
