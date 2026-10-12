# 1. Reverse Connection Architecture for NAT/Firewall Traversal

Date: 2026-10-12
Status: Accepted

## Context
In a realistic distributed environment, agents run across disparate datacenters, edge locations, or developer laptops behind network address translation (NAT) and strict firewalls. The central control plane cannot initiate inbound TCP connections to agents.

## Decision
We implement a **Reverse Connection Architecture**:
- Agents establish outbound persistent WebSocket connections (`ws://control-plane:4000/ws/agent`) to the Control Plane.
- Control plane authenticates and maintains active socket pools indexed by `agentId`.
- Dispatched jobs, cancellation commands, and heartbeat acks are routed down the established bidirectional socket.

## Consequences
- **Positive**: Zero inbound port-forwarding or public IP requirements for worker agents; immediate bidirectional communication.
- **Negative**: Control plane must manage stateful socket connections; horizontal scaling of the control plane will require an agent routing layer or message broker (addressed in Stage 2/4).
